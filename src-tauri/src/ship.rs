//! Ship: install a verified worktree build into the daily app, safely, even from a chat inside the app being replaced
//! (Phase 1b, WP3: `docs/PHASE-1B-DEV-SETUP.md`, "Ship").
//!
//! The whole path:
//! 1. `scripts/hub-ship.mjs` (`npm run hub:ship`, the `app.ship` action, later a button) checks the build, copies it
//!    to `<data>/ship/<id>/staged/`, writes `state.json` ("staged") and starts `runner.mjs` (a copy of
//!    `scripts/hub-ship-runner.mjs`) detached in its own session, outside this app's process tree once hub-ship.mjs
//!    exits (r53: no launchd job, so no "node can run in the background" notice; `--launcher launchd` still submits one).
//! 2. This app's watcher ([`init`]) sees the staged build and accepts it only if its signature matches the app's own
//!    (`accepted.json`, or `refused.json` with why). It then quits for the update once no other turn is running, or
//!    straight away on "Restart now" (`window::request_update_quit`): the normal quit path without the dialog, cut
//!    turns saved for resume and marked with the ship's id.
//! 3. The runner waits for this process to exit, backs up the database files and `monos/`, renames the old app to
//!    `previous.app.off`, moves the staged build into place ("trial") and opens it.
//! 4. The new build ([`startup`] returns [`Boot::Trial`]) holds auto-resume, habits and automations ([`holding`]) until
//!    its window and database are up ([`ship_ready`]), then writes `committed.json`.
//! 5. No commit in time, or an early exit, and the runner rolls back: the old app and the database copy go back.
//! 6. `receipt.json` and `runner.log` say what happened; Today shows it and the shipping Lead's resume note carries it.
//!
//! **When the runner dies** (a crash, a reboot), [`startup`] finishes what it left before the database opens: a trial
//! (this build holds and the runner is restarted to watch it), a restore (the old app and database go back), or a
//! ship that never got as far as the swap (called off). [`plan`] is that decision, as a pure function. The restart
//! runs only a record this app wrote: the runner scripts must be this build's own copies, the node binary and any
//! launchd plist must sit outside the ship folder, and `record.mac` must match the fields the runner must not change.
//! A record planted in the data folder is not started.
//!
//! Only whoever holds `<id>/runner.lock` (an exclusive SQLite transaction, like the instance lock) writes `state.json`:
//! the runner while it runs, this app only when the runner is gone. The apps' own notes are separate files.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::instance::{self, Identity, InstanceLock, Kind};

pub const SHIP_DIR: &str = "ship";
pub const CURRENT: &str = "current.json";
pub const STATE: &str = "state.json";
pub const RUNNER_LOCK: &str = "runner.lock";
pub const ACCEPTED: &str = "accepted.json";
pub const REFUSED: &str = "refused.json";
pub const COMMITTED: &str = "committed.json";
pub const TRIAL_CHECKS: &str = "trial-checks.json";
pub const RECEIPT: &str = "receipt.json";
/// Ash's own answer to "does the build work?" (I4). No file means pending; only he writes a yes or a no.
pub const ACCEPTANCE: &str = "acceptance.json";
pub const SEEN: &str = "seen.json";
pub const RUNNER_LOG: &str = "runner.log";
pub const STAGED_DIR: &str = "staged";
pub const BACKUP_DIR: &str = "backup";
pub const PREVIOUS_APP: &str = "previous.app.off";
pub const REJECTED_APP: &str = "rejected.app.off";
pub const REJECTED_MONOS: &str = "rejected-monos";
/// A trial build that keeps dying before it commits, with nobody watching, is rolled back on this start.
pub const MAX_TRIAL_STARTS: u32 = 3;
/// The database files a ship backs up and restores, byte for byte.
pub const DB_FILES: [&str; 3] = ["monocode.db", "monocode.db-wal", "monocode.db-shm"];
pub const MONOS: &str = "monos";
/// Tauri event: the ship status changed. Payload: [`status`].
pub const EVENT_CHANGED: &str = "ship:changed";

/// `scripts/hub-ship.mjs` looks for this in the installed binary: that app can take a ship (quit for update, trial).
#[used]
static SHIP_MARKER: &str = "MONOCODE-SHIP:1";

const WATCH_EVERY: Duration = Duration::from_secs(2);
const RETRY_QUIT_EVERY: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Checked and copied in; the runner hasn't started waiting yet.
    Staged,
    /// The runner waits for the running app to quit for the update.
    Waiting,
    /// The runner is backing up the database and swapping the apps.
    Swapping,
    /// The new build is open and has to commit.
    Trial,
    Committed,
    /// The old app and database are going back.
    RollingBack,
    RolledBack,
    /// Called off before anything changed.
    Cancelled,
    /// Something went wrong that the runner couldn't put right; the receipt says what.
    Failed,
}

impl Phase {
    pub fn is_final(self) -> bool {
        matches!(
            self,
            Self::Committed | Self::RolledBack | Self::Cancelled | Self::Failed
        )
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Waiting => "waiting",
            Self::Swapping => "swapping",
            Self::Trial => "trial",
            Self::Committed => "committed",
            Self::RollingBack => "rolling-back",
            Self::RolledBack => "rolled-back",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

// ---- the record ------------------------------------------------------------------------------------------------------

/// One ship folder and its `state.json`, kept as JSON so fields this build doesn't know survive a rewrite.
pub struct Ship {
    pub dir: PathBuf,
    pub doc: Value,
}

impl Ship {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let raw = std::fs::read(dir.join(STATE))
            .map_err(|error| format!("Couldn't read {}: {error}", dir.join(STATE).display()))?;
        let doc: Value = serde_json::from_slice(&raw)
            .map_err(|error| format!("{} isn't JSON: {error}", dir.join(STATE).display()))?;
        if !doc.is_object() {
            return Err(format!("{} isn't a ship record", dir.join(STATE).display()));
        }
        Ok(Self {
            dir: dir.to_path_buf(),
            doc,
        })
    }

    fn text(&self, pointer: &str) -> &str {
        self.doc
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or("")
    }

    pub fn id(&self) -> &str {
        self.text("/id")
    }

    pub fn phase(&self) -> Option<Phase> {
        serde_json::from_value(self.doc.get("phase")?.clone()).ok()
    }

    pub fn step(&self, name: &str) -> bool {
        self.doc
            .pointer(&format!("/steps/{name}"))
            .is_some_and(|value| !value.is_null())
    }

    fn object(&mut self, key: &str) -> &mut Map<String, Value> {
        let doc = self
            .doc
            .as_object_mut()
            .expect("a ship record is an object");
        let entry = doc
            .entry(key.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        entry.as_object_mut().expect("just made an object")
    }

    fn mark_step(&mut self, name: &str) {
        self.object("steps").insert(name.into(), json!(now_iso()));
    }

    fn set(&mut self, key: &str, value: Value) {
        if let Some(doc) = self.doc.as_object_mut() {
            doc.insert(key.into(), value);
        }
    }

    fn set_phase(&mut self, phase: Phase, note: &str) {
        self.set("phase", json!(phase.name()));
        let entry = json!({ "at": now_iso(), "phase": phase.name(), "note": note, "by": "app" });
        let doc = self
            .doc
            .as_object_mut()
            .expect("a ship record is an object");
        match doc.get_mut("history").and_then(Value::as_array_mut) {
            Some(history) => history.push(entry),
            None => {
                doc.insert("history".into(), json!([entry]));
            }
        }
    }

    pub fn new_sha(&self) -> &str {
        self.text("/to/sha")
    }

    pub fn old_sha(&self) -> &str {
        self.text("/from/sha")
    }

    pub fn app_path(&self) -> PathBuf {
        PathBuf::from(self.text("/appPath"))
    }

    pub fn data_dir(&self) -> PathBuf {
        PathBuf::from(self.text("/dataDir"))
    }

    fn trial_starts(&self) -> u32 {
        self.doc
            .pointer("/trial/starts")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32
    }

    /// Written whole and renamed into place, so a reader never sees half a record.
    pub fn save(&mut self) -> Result<(), String> {
        self.set("updatedAt", json!(now_iso()));
        write_json(&self.dir.join(STATE), &self.doc)
    }
}

/// `<data>/ship/current.json` names the newest ship folder.
pub fn current_id(data: &Path) -> Option<String> {
    let raw = std::fs::read(data.join(SHIP_DIR).join(CURRENT)).ok()?;
    let value: Value = serde_json::from_slice(&raw).ok()?;
    let id = value.get("id")?.as_str()?;
    valid_id(id).then(|| id.to_string())
}

/// Ship ids are folder names: `20261019-210405-abc1234`, `…-rollback`. Nothing that can climb out of `ship/`.
pub fn valid_id(id: &str) -> bool {
    (1..=96).contains(&id.len())
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !id.contains("..")
}

fn ship_dir(data: &Path, id: &str) -> PathBuf {
    data.join(SHIP_DIR).join(id)
}

// ---- what to do at startup (pure) --------------------------------------------------------------------------------

/// Which build this process is, against the ship's record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Me {
    /// The build being shipped.
    New,
    /// The build it replaces.
    Old,
    Other,
}

pub fn me_for(own_sha: &str, to_sha: &str, from_sha: &str) -> Me {
    if !own_sha.is_empty() && own_sha == to_sha {
        Me::New
    } else if !own_sha.is_empty() && own_sha == from_sha {
        Me::Old
    } else {
        Me::Other
    }
}

/// Everything [`plan`] needs to know.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts {
    pub phase: Phase,
    /// The old app has left its place (`steps.oldMoved`).
    pub old_moved: bool,
    /// The new build is in place (`steps.newMoved`).
    pub new_moved: bool,
    /// A rollback's runner began putting the older database in place (`steps.dbReplacing`): live files may have
    /// changed even though no app has moved.
    pub db_replaced: bool,
    /// `committed.json` is there.
    pub committed: bool,
    /// Someone holds `runner.lock`.
    pub runner_alive: bool,
    pub me: Me,
    /// How many times a trial was started with nobody watching it.
    pub trial_starts: u32,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    Normal,
    /// This build is on trial: hold auto-resume, habits and automations until it commits. Restart the runner to watch
    /// it if it is gone.
    Trial,
    /// The new build committed, but the runner died before writing it down.
    FinishCommit,
    /// The runner stopped before anything moved: call the ship off.
    Cancel(String),
    /// Put the old app and database back, from wherever a restore stopped.
    Restore(String),
    /// The runner is in the middle of moving files (or there's nothing this build can safely do): exit and leave them.
    Leave,
}

pub fn plan(facts: &Facts) -> Plan {
    use Phase::*;
    if facts.phase.is_final() {
        return Plan::Normal;
    }
    let on_trial = facts.phase == Trial || (facts.phase == Swapping && facts.new_moved);
    if on_trial && facts.committed {
        return if facts.runner_alive {
            Plan::Normal
        } else {
            Plan::FinishCommit
        };
    }
    if facts.runner_alive {
        return match facts.phase {
            // The runner is waiting for this app to quit; the watcher handles it.
            Staged | Waiting => Plan::Normal,
            _ if on_trial && facts.me == Me::New => Plan::Trial,
            _ => Plan::Leave,
        };
    }
    match facts.phase {
        Staged | Waiting => Plan::Cancel(
            "The ship runner stopped before the swap, so nothing changed. Ship again.".into(),
        ),
        Swapping if !facts.old_moved && !facts.db_replaced => Plan::Cancel(
            "The swap was interrupted before anything moved, so nothing changed. Ship again."
                .into(),
        ),
        // A rollback's runner was putting the older database in place: the live files may be partly that copy, so this
        // ship's own backup goes back (no app has moved).
        Swapping if !facts.old_moved => match facts.me {
            Me::New | Me::Old => {
                Plan::Restore("The rollback was cut off while its database copy went in.".into())
            }
            Me::Other => Plan::Leave,
        },
        // The old app is out and the new one isn't in: no build can be running from its place. Only the runner
        // finishes this.
        Swapping if !facts.new_moved => Plan::Leave,
        _ if on_trial => match facts.me {
            Me::New if facts.trial_starts < MAX_TRIAL_STARTS => Plan::Trial,
            Me::New => Plan::Restore(format!(
                "The new build started {MAX_TRIAL_STARTS} times without committing."
            )),
            Me::Old => {
                Plan::Restore("The trial was cut off before the new build committed.".into())
            }
            Me::Other => Plan::Leave,
        },
        RollingBack => match facts.me {
            Me::New | Me::Old => Plan::Restore(
                facts
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Finishing an interrupted rollback.".into()),
            ),
            Me::Other => Plan::Leave,
        },
        _ => Plan::Normal,
    }
}

// ---- startup ---------------------------------------------------------------------------------------------------------

/// How this process starts, after [`startup`] has dealt with any ship.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Boot {
    Normal,
    Trial { id: String, dir: PathBuf },
}

impl Boot {
    /// Handed to every window before its scripts run (`window.__MONOCODE_APP__.ship`), so a build on trial holds
    /// auto-resume, habits and automations from its very first render, before `ship_status` answers.
    pub fn for_window(&self) -> Value {
        match self {
            Boot::Normal => json!({ "holding": false }),
            Boot::Trial { id, .. } => {
                json!({ "holding": true, "trial": { "id": id, "committed": false } })
            }
        }
    }
}

/// Right after the instance lock, before the database opens. The daily app finishes whatever a dead runner left
/// (see [`plan`]); a dev copy is never shipped. May exit: after putting the old build back from inside the new one
/// (it reopens the old app), or to leave a runner's work alone.
pub fn startup(identity: &Identity, data: &Path) -> Boot {
    if identity.kind != Kind::Daily {
        return Boot::Normal;
    }
    let Some(id) = current_id(data) else {
        return Boot::Normal;
    };
    let dir = ship_dir(data, &id);
    match Ship::load(&dir) {
        Ok(ship) if ship.phase().is_some_and(Phase::is_final) => return Boot::Normal,
        Ok(_) => {}
        Err(_) => return Boot::Normal,
    }
    // Whoever holds this writes state.json. Held to the end of this function when the runner is gone.
    let lock = InstanceLock::acquire_file(&dir.join(RUNNER_LOCK), Duration::ZERO).ok();
    let runner_alive = lock.is_none();
    let Ok(mut ship) = Ship::load(&dir) else {
        return Boot::Normal;
    };
    // restore and reopen run outside the sandbox and used to trust state.json with no mac. A missing or wrong mac
    // is not a record this app signed, so it is left alone. A final phase already returned above.
    if !mac_matches(&ship) {
        log(
            &dir,
            "startup: record.mac does not match, so this record is not restored",
        );
        return Boot::Normal;
    }
    let Some(phase) = ship.phase() else {
        return Boot::Normal;
    };
    let me = me_for(&instance::stamp().sha, ship.new_sha(), ship.old_sha());
    let facts = Facts {
        phase,
        old_moved: ship.step("oldMoved"),
        new_moved: ship.step("newMoved"),
        db_replaced: ship.step("dbReplacing") || ship.step("dbReplaced"),
        committed: dir.join(COMMITTED).is_file(),
        runner_alive,
        me,
        trial_starts: ship.trial_starts(),
        reason: ship
            .doc
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    let decision = plan(&facts);
    log(&dir, &format!("startup: {facts:?} -> {decision:?}"));
    match decision {
        Plan::Normal => Boot::Normal,
        Plan::Leave => {
            eprintln!(
                "monocode: ship {id} is {}; leaving it to its runner.",
                phase.name()
            );
            std::process::exit(0);
        }
        Plan::Trial => {
            if !runner_alive {
                let starts = ship.trial_starts() + 1;
                if phase != Phase::Trial {
                    ship.set_phase(
                        Phase::Trial,
                        "The new build was in place; its trial goes on.",
                    );
                }
                let trial = ship.object("trial");
                trial.insert("starts".into(), json!(starts));
                trial.insert("resumedAt".into(), json!(now_iso()));
                // This process is the build now: the runner finds it afresh in running.json.
                for stale in ["pid", "startTime", "seenAt"] {
                    trial.remove(stale);
                }
                let _ = ship.save();
                drop(lock);
                restart_runner(&ship);
            }
            Boot::Trial { id, dir }
        }
        Plan::FinishCommit => {
            finish_commit(&mut ship, "app");
            Boot::Normal
        }
        Plan::Cancel(reason) => {
            ship.set("reason", json!(reason));
            ship.set_phase(Phase::Cancelled, &reason);
            let _ = ship.save();
            write_receipt(&ship, "app");
            Boot::Normal
        }
        Plan::Restore(reason) => {
            if phase != Phase::RollingBack {
                ship.set("reason", json!(reason));
                ship.set_phase(Phase::RollingBack, &reason);
                let _ = ship.save();
            }
            match restore(&mut ship, me) {
                Ok(()) => {
                    ship.set_phase(
                        Phase::RolledBack,
                        "The old build and its database are back.",
                    );
                    let saved = ship.save();
                    write_receipt(&ship, "app");
                    // WP-78: the rollback is on the record. restore() itself writes nothing.
                    if saved.is_ok() {
                        note_ship(
                            &ship,
                            crate::activity::SHIP_ROLLBACK,
                            "Rolled back to the previous build.",
                        );
                    }
                    if me == Me::New {
                        // This process is the build that was just put aside: open the old one and go.
                        drop(lock);
                        reopen(&mut ship);
                        std::process::exit(0);
                    }
                }
                Err(error) => {
                    ship.set(
                        "reason",
                        json!(format!("{reason} Restoring failed: {error}")),
                    );
                    ship.set_phase(Phase::Failed, &error);
                    let _ = ship.save();
                    write_receipt(&ship, "app");
                }
            }
            Boot::Normal
        }
    }
}

/// Put the old app and the database back, one idempotent step at a time (the runner does the same). The location
/// rule means this process runs from the app's place, so `me` says what is there.
pub fn restore(ship: &mut Ship, me: Me) -> Result<(), String> {
    let app = ship.app_path();
    if !ship.step("newRemoved") {
        if me == Me::New && app.exists() {
            let aside = ship.dir.join(REJECTED_APP);
            if aside.exists() {
                std::fs::remove_dir_all(&aside).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&app, &aside)
                .map_err(|error| format!("Couldn't move the new build aside: {error}"))?;
        }
        ship.mark_step("newRemoved");
        ship.save()?;
    }
    if !ship.step("oldRestored") {
        let previous = ship.dir.join(PREVIOUS_APP);
        if me == Me::New || !app.exists() {
            if !previous.exists() {
                return Err(format!(
                    "The previous build isn't at {}",
                    previous.display()
                ));
            }
            std::fs::rename(&previous, &app)
                .map_err(|error| format!("Couldn't put the previous build back: {error}"))?;
        }
        ship.mark_step("oldRestored");
        ship.save()?;
    }
    if !ship.step("dbRestored") {
        if ship.step("backup") {
            let restored = restore_db(ship)?;
            ship.object("db").insert("restored".into(), restored);
        }
        ship.mark_step("dbRestored");
        ship.save()?;
    }
    Ok(())
}

/// Copy the backed-up database files back byte for byte (a file the backup didn't have goes), check each against the
/// checksum taken at backup time, and swap `monos/` back. Same steps as the runner's `restoreData`.
///
/// Nothing changes unless the backup is all there and right: every file is checked against its checksum and copied in
/// beside its live file first, and a file the checksums name that isn't in the backup is an error, not a removal.
pub fn restore_db(ship: &Ship) -> Result<Value, String> {
    let backup = ship.dir.join(BACKUP_DIR);
    let data = ship.data_dir();
    let expected = ship.doc.pointer("/db/backup").cloned().unwrap_or(json!({}));
    if !backup.is_dir() {
        return Err(format!("The database copy {} is missing", backup.display()));
    }
    let saved = backup.join(MONOS);
    let staging = data.join(".monos.restoring");
    let mut steps = Vec::new();
    if let Err(error) = prepare_restore(&backup, &data, &expected, &saved, &staging, &mut steps) {
        for step in &steps {
            if let Some((temporary, _)) = &step.2 {
                let _ = std::fs::remove_file(temporary);
            }
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let mut restored = Map::new();
    for (name, to, copied) in steps {
        match copied {
            Some((temporary, sum)) => {
                std::fs::rename(&temporary, &to).map_err(|e| e.to_string())?;
                restored.insert(name.into(), json!(sum));
            }
            None if to.exists() => std::fs::remove_file(&to).map_err(|e| e.to_string())?,
            None => {}
        }
    }
    let live = data.join(MONOS);
    if live.exists() {
        let aside = ship.dir.join(REJECTED_MONOS);
        if aside.exists() {
            std::fs::remove_dir_all(&aside).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&live, &aside).map_err(|e| e.to_string())?;
    }
    if saved.is_dir() {
        std::fs::rename(&staging, &live).map_err(|e| e.to_string())?;
    }
    Ok(Value::Object(restored))
}

/// One database file to put back: its name, its live path, and its checked copy beside it with the checksum (none:
/// the backup didn't have it, so the live one goes).
type RestoreStep = (&'static str, PathBuf, Option<(PathBuf, String)>);

/// [`restore_db`]'s checks and copies, before any live file changes.
fn prepare_restore(
    backup: &Path,
    data: &Path,
    expected: &Value,
    saved_monos: &Path,
    staging: &Path,
    steps: &mut Vec<RestoreStep>,
) -> Result<(), String> {
    for name in DB_FILES {
        let from = backup.join(name);
        let to = data.join(name);
        let want = expected.get(name).and_then(Value::as_str);
        if !from.is_file() {
            if want.is_some() {
                return Err(format!(
                    "{name} is missing from the database copy in {}",
                    backup.display()
                ));
            }
            steps.push((name, to, None));
            continue;
        }
        let sum = sha256_file(&from)?;
        if let Some(want) = want.filter(|want| *want != sum) {
            return Err(format!("{name} doesn't match its backup ({sum} vs {want})"));
        }
        let temporary = data.join(format!(".{name}.restoring"));
        steps.push((name, to, Some((temporary.clone(), sum.clone()))));
        std::fs::copy(&from, &temporary)
            .map_err(|error| format!("Couldn't copy {name} back: {error}"))?;
        let copied = sha256_file(&temporary)?;
        if copied != sum {
            return Err(format!(
                "The copy of {name} doesn't match its backup ({copied} vs {sum})"
            ));
        }
    }
    if staging.exists() {
        std::fs::remove_dir_all(staging).map_err(|e| e.to_string())?;
    }
    if saved_monos.is_dir() {
        copy_dir(saved_monos, staging)?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            {
                let link = std::fs::read_link(entry.path()).map_err(|e| e.to_string())?;
                std::os::unix::fs::symlink(link, &target).map_err(|e| e.to_string())?;
            }
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn finish_commit(ship: &mut Ship, by: &str) {
    ship.set("reason", Value::Null);
    ship.set_phase(Phase::Committed, "The new build committed.");
    let _ = ship.save();
    write_receipt(ship, by);
}

/// Who asked for this ship. No session on the record means the person.
fn ship_initiator(ship: &Ship) -> crate::activity::Who {
    ship.doc
        .pointer("/requestedBy/sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| crate::activity::Who::first_mate(id, ""))
        .unwrap_or_else(crate::activity::Who::person)
}

/// A ship hub-ship accepted. `accepted` false, or no data folder, writes nothing.
fn note_accepted_ship(
    accepted: bool,
    data: Option<&Path>,
    requested_by: Option<&str>,
    target: &str,
) {
    if !accepted {
        return;
    }
    let Some(data) = data else {
        return;
    };
    let initiator = match requested_by.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => crate::activity::Who::first_mate(id, ""),
        None => crate::activity::Who::person(),
    };
    crate::activity::note_db(
        &data.join("monocode.db"),
        crate::activity::SHIP,
        &crate::activity::Who::app(),
        &initiator,
        "",
        target,
        "Started a ship.",
        "",
    );
}

/// Writes the commit, then the activity row. A failed commit writes no row.
fn commit_and_note_trial(
    trial: &Mutex<Option<TrialState>>,
    dir: &Path,
    note: &Value,
) -> Result<(), String> {
    record_commit(trial, dir, note)?;
    note_trial_committed(dir);
    Ok(())
}

/// The trial's commit is on record. A missing ship folder writes nothing.
fn note_trial_committed(dir: &Path) {
    if let Ok(ship) = Ship::load(dir) {
        note_ship(
            &ship,
            crate::activity::SHIP_TRIAL,
            "The new build's trial committed.",
        );
    }
}

fn note_ship(ship: &Ship, kind: &str, summary: &str) {
    crate::activity::note_db(
        &ship.data_dir().join("monocode.db"),
        kind,
        &crate::activity::Who::app(),
        &ship_initiator(ship),
        "",
        ship.id(),
        summary,
        "",
    );
}

/// What `receipt.json` says. The runner writes the same shape.
pub fn receipt(ship: &Ship, by: &str) -> Value {
    let phase = ship.phase();
    let running = match phase {
        Some(Phase::Committed) => ship.doc.get("to"),
        _ => ship.doc.get("from"),
    };
    json!({
        "id": ship.id(),
        "kind": ship.doc.get("kind").cloned().unwrap_or(json!("ship")),
        "outcome": phase.map(Phase::name).unwrap_or("unknown"),
        "reason": ship.doc.get("reason").cloned().unwrap_or(Value::Null),
        "from": ship.doc.get("from").cloned().unwrap_or(Value::Null),
        "to": ship.doc.get("to").cloned().unwrap_or(Value::Null),
        "running": running.cloned().unwrap_or(Value::Null),
        "requestedBy": ship.doc.get("requestedBy").cloned().unwrap_or(Value::Null),
        "drill": ship.doc.get("drill").cloned().unwrap_or(Value::Null),
        "startedAt": ship.doc.get("createdAt").cloned().unwrap_or(Value::Null),
        "finishedAt": now_iso(),
        "finishedBy": by,
        "steps": ship.doc.get("steps").cloned().unwrap_or(json!({})),
        "db": ship.doc.get("db").cloned().unwrap_or(json!({})),
        "shipDir": ship.dir,
        "log": ship.dir.join(RUNNER_LOG),
    })
}

fn write_receipt(ship: &Ship, by: &str) {
    let _ = write_json(&ship.dir.join(RECEIPT), &receipt(ship, by));
}

/// `launchctl submit` for a ship's runner, the same command line hub-ship.mjs's `runnerSubmitArgs` builds.
fn runner_submit_args(label: &str, node: &str, dir: &Path, home: &str) -> Vec<String> {
    let log = dir.join(RUNNER_LOG).to_string_lossy().into_owned();
    vec![
        "submit".into(),
        "-l".into(),
        label.into(),
        "-o".into(),
        log.clone(),
        "-e".into(),
        log,
        "--".into(),
        "/usr/bin/env".into(),
        format!("HOME={home}"),
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin".into(),
        node.into(),
        "--disable-warning=ExperimentalWarning".into(),
        dir.join("runner.mjs").to_string_lossy().into_owned(),
        dir.to_string_lossy().into_owned(),
    ]
}

/// The runner scripts this build copies into a ship folder (`scripts/hub-ship.mjs` `stageShip`). A record whose
/// copies differ was not written by this app.
const APP_RUNNER: &str = include_str!("../../scripts/hub-ship-runner.mjs");
const APP_SHIP_PLATFORM: &str = include_str!("../../scripts/ship-platform.mjs");

fn file_is(path: &Path, expected: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| bytes == expected.as_bytes())
}

/// True when `path` is inside `root` (after resolving links), or when it is not on disk but lexically inside, or when
/// it contains `..` and cannot be resolved. An empty root matches nothing.
fn path_is_under(root: &Path, path: &Path) -> bool {
    if root.as_os_str().is_empty() {
        return false;
    }
    let Ok(root) = std::fs::canonicalize(root) else {
        // Not a path we can prove is outside the ship folder.
        return true;
    };
    if let Ok(path) = std::fs::canonicalize(path) {
        return path.starts_with(&root);
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return true;
    }
    path.starts_with(&root)
}

/// A node binary this app would have recorded: absolute, named `node`, outside the ship folder and the data folder,
/// and not a script. A missing file or a `#!` file is not ours.
fn node_path_is_ours(ship: &Ship, node: &str) -> bool {
    if node.is_empty() {
        return false;
    }
    let path = Path::new(node);
    if !path.is_absolute() {
        return false;
    }
    match path.file_name().and_then(|name| name.to_str()) {
        Some("node" | "node.exe") => {}
        _ => return false,
    }
    if path_is_under(&ship.dir, path) {
        return false;
    }
    if let Some(ships) = ship.dir.parent() {
        if path_is_under(ships, path) {
            return false;
        }
    }
    if path_is_under(&ship.data_dir(), path) {
        return false;
    }
    !binary_is_script(path)
}

/// True when the file is a script, or when it cannot be read as a regular file. Only the first two bytes are read.
fn binary_is_script(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return true;
    };
    if !meta.is_file() {
        return true;
    }
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return true,
    };
    let mut buf = [0u8; 2];
    match std::io::Read::read(&mut file, &mut buf) {
        Ok(2) => buf == *b"#!",
        _ => true,
    }
}

/// While the sandbox is on, an agent's `app.ship` is refused unless Ash tapped.
pub(crate) fn agent_ship_refused(sandbox_on: bool, ash_tap: bool) -> bool {
    sandbox_on && !ash_tap
}

/// Sidecar next to `state.json`. Not a field in the record: the runner rewrites `phase`, and a mac of the whole file
/// would fail on that legitimate write.
const RECORD_MAC: &str = "record.mac";
#[cfg(not(test))]
const SHIP_MAC_SERVICE: &str = "monocode-hub:ship-mac";
#[cfg(not(test))]
const SHIP_MAC_ACCOUNT: &str = "record";

/// The fields the runner must not change, in a fixed order. `phase` is not here.
fn canonical_record(ship: &Ship) -> String {
    let mut lines = vec![
        format!("id={}", ship.text("/id")),
        format!("node={}", ship.text("/node")),
        format!("appPath={}", ship.text("/appPath")),
        format!("dataDir={}", ship.text("/dataDir")),
        format!("home={}", ship.text("/home")),
        format!("launch.mode={}", ship.text("/launch/mode")),
    ];
    if let Some(env) = ship.doc.pointer("/launch/env").and_then(Value::as_object) {
        let mut keys: Vec<&String> = env.keys().collect();
        keys.sort();
        for key in keys {
            let value = match env.get(key) {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            lines.push(format!("launch.env.{key}={value}"));
        }
    }
    lines.push(format!("launchd.plist={}", ship.text("/launchd/plist")));
    lines.join("\n")
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key_block = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0u8; BLOCK];
    let mut opad = [0u8; BLOCK];
    for (index, byte) in key_block.iter().enumerate() {
        ipad[index] = byte ^ 0x36;
        opad[index] = byte ^ 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    let done = outer.finalize();
    let mut mac = [0u8; 32];
    mac.copy_from_slice(&done);
    mac
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// The test key never touches the Keychain. A real build reads `monocode-hub:ship-mac` (a dev copy's name is scoped)
/// and stores a new one the first time.
#[cfg(test)]
fn ship_mac_key() -> Result<Vec<u8>, String> {
    Ok(b"monocode-hub-test-ship-mac-key".to_vec())
}

#[cfg(not(test))]
fn ship_mac_key() -> Result<Vec<u8>, String> {
    match crate::hub_keychain::read(SHIP_MAC_SERVICE, SHIP_MAC_ACCOUNT)? {
        Some(secret) if !secret.is_empty() => Ok(secret.into_bytes()),
        _ => {
            let secret = uuid::Uuid::new_v4().simple().to_string();
            crate::hub_keychain::store(SHIP_MAC_SERVICE, SHIP_MAC_ACCOUNT, &secret)?;
            Ok(secret.into_bytes())
        }
    }
}

fn mac_matches(ship: &Ship) -> bool {
    let Ok(key) = ship_mac_key() else {
        return false;
    };
    let Ok(got) = std::fs::read_to_string(ship.dir.join(RECORD_MAC)) else {
        return false;
    };
    let got = got.trim();
    let expect = hex_encode(&hmac_sha256(&key, canonical_record(ship).as_bytes()));
    if got.len() != expect.len() {
        return false;
    }
    let diff = got
        .bytes()
        .zip(expect.bytes())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right));
    diff == 0
}

/// Write `record.mac` for the record as it is now. Called after a ship this app started, not by the runner.
pub(crate) fn sign_ship_record(ship: &Ship) -> Result<(), String> {
    let mac = hex_encode(&hmac_sha256(
        &ship_mac_key()?,
        canonical_record(ship).as_bytes(),
    ));
    let temp = ship
        .dir
        .join(format!("record.mac.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, mac).map_err(|error| error.to_string())?;
    std::fs::rename(&temp, ship.dir.join(RECORD_MAC)).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error.to_string()
    })
}

/// The runner scripts match this build's copies, the node binary is the app's own, a launchd plist is not a file
/// inside the ship folder, and `record.mac` matches the fields the runner must not change. A missing or wrong mac
/// was planted and must not be started.
fn runner_record_is_ours(ship: &Ship) -> bool {
    if !file_is(&ship.dir.join("runner.mjs"), APP_RUNNER)
        || !file_is(&ship.dir.join("ship-platform.mjs"), APP_SHIP_PLATFORM)
        || !node_path_is_ours(ship, ship.text("/node"))
        || !mac_matches(ship)
    {
        return false;
    }
    match ship.doc.pointer("/launchd/plist").and_then(Value::as_str) {
        Some(plist) if !plist.is_empty() => {
            !path_is_under(&ship.dir, Path::new(plist))
                && ship
                    .dir
                    .parent()
                    .is_none_or(|ships| !path_is_under(ships, Path::new(plist)))
                && !path_is_under(&ship.data_dir(), Path::new(plist))
        }
        _ => true,
    }
}

/// The runner keeps going under launchd (or as a plain detached process when the ship said so). A node path or a
/// plist from a record this app did not write is not started: an agent can plant both in the data folder, and startup
/// runs outside the sandbox.
fn restart_runner(ship: &Ship) {
    if !runner_record_is_ours(ship) {
        log(
            &ship.dir,
            "refused to restart the runner: the record is not one this app wrote",
        );
        return;
    }
    // WP-09: a Windows task or a systemd unit, from the script this ship stored.
    // macOS has no service record, so this does not run there.
    #[cfg(not(target_os = "macos"))]
    if crate::platform::ship::rerun(&ship.doc, &ship.dir) {
        log(&ship.dir, "restarted the runner (service)");
        return;
    }
    if let (Some(label), Some(domain), Some(plist)) = (
        ship.doc.pointer("/launchd/label").and_then(Value::as_str),
        ship.doc.pointer("/launchd/domain").and_then(Value::as_str),
        ship.doc.pointer("/launchd/plist").and_then(Value::as_str),
    ) {
        let started = Command::new("/bin/launchctl")
            .args(["kickstart", &format!("{domain}/{label}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !started {
            let _ = Command::new("/bin/launchctl")
                .args(["bootstrap", domain, plist])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        log(&ship.dir, &format!("restarted the runner ({label})"));
        return;
    }
    // r50: a runner submitted to launchd with no plist (so no login item and no "App Background Activity" banner).
    if let (Some(label), Some(domain), true) = (
        ship.doc.pointer("/launchd/label").and_then(Value::as_str),
        ship.doc.pointer("/launchd/domain").and_then(Value::as_str),
        ship.doc
            .pointer("/launchd/submitted")
            .and_then(Value::as_bool)
            == Some(true),
    ) {
        let started = Command::new("/bin/launchctl")
            .args(["kickstart", &format!("{domain}/{label}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        let node = ship.text("/node");
        if !started && !node.is_empty() {
            let _ = Command::new("/bin/launchctl")
                .args(runner_submit_args(
                    label,
                    node,
                    &ship.dir,
                    ship.text("/home"),
                ))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        log(
            &ship.dir,
            &format!("restarted the runner ({label}, submitted)"),
        );
        return;
    }
    let node = ship.text("/node");
    if node.is_empty() {
        return;
    }
    let mut command = Command::new(node);
    command
        .args(["--disable-warning=ExperimentalWarning"])
        .arg(ship.dir.join("runner.mjs"))
        .arg(&ship.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let _ = command.spawn();
    log(&ship.dir, "restarted the runner (detached)");
}

/// Open the app at its place: through Launch Services normally, or the binary itself with the ship's environment
/// (a drill under a temporary HOME, where Launch Services would start it with the real HOME).
fn reopen(ship: &mut Ship) {
    let app = ship.app_path();
    let direct = ship.text("/launch/mode") == "direct";
    let result = if direct {
        let mut pairs = Vec::new();
        if let Some(env) = ship.doc.pointer("/launch/env").and_then(Value::as_object) {
            for (key, value) in env {
                if let Some(value) = value.as_str() {
                    pairs.push((key.clone(), value.to_string()));
                }
            }
        }
        // The binary inside the bundle, including monocode.exe on Windows.
        // The ship's launch env is overlaid; it is not dropped.
        crate::platform::ship::spawn_app_env(&app, &pairs)
    } else {
        // -n: this process (the build being put aside) still runs under the same identifier, and a plain open would
        // only bring it to the front.
        #[cfg(target_os = "macos")]
        {
            Command::new("/usr/bin/open")
                .arg("-n")
                .arg(&app)
                .status()
                .map(|_| ())
        }
        // WP-09: no Launch Services off the Mac. The binary is the one inside the bundle.
        #[cfg(not(target_os = "macos"))]
        {
            crate::platform::ship::spawn_app(&app)
        }
    };
    match result {
        Ok(()) => {
            ship.mark_step("reopened");
            let _ = ship.save();
        }
        Err(error) => log(
            &ship.dir,
            &format!("couldn't reopen {}: {error}", app.display()),
        ),
    }
}

// ---- the trial -------------------------------------------------------------------------------------------------------

struct TrialState {
    id: String,
    dir: PathBuf,
    committed: bool,
    checking: bool,
}

static TRIAL: Mutex<Option<TrialState>> = Mutex::new(None);

/// True while this build is on trial and hasn't committed: auto-resume, habits and automations wait.
pub fn holding() -> bool {
    TRIAL
        .lock()
        .ok()
        .and_then(|trial| trial.as_ref().map(|trial| !trial.committed))
        .unwrap_or(false)
}

/// The window calls this once it has drawn the workspace. The database is checked off the main thread; when both are
/// up, the build commits.
#[tauri::command]
pub fn ship_ready(app: AppHandle) -> Value {
    if let Some((id, dir)) = begin_checks(&TRIAL) {
        let app = app.clone();
        std::thread::spawn(move || run_trial_checks(&app, &id, &dir));
    }
    status()
}

/// The trial's checks start once at a time, and never after it committed: `(id, dir)` when they start now.
fn begin_checks(trial: &Mutex<Option<TrialState>>) -> Option<(String, PathBuf)> {
    let mut trial = trial.lock().unwrap_or_else(|poison| poison.into_inner());
    match trial.as_mut() {
        Some(trial) if !trial.committed && !trial.checking => {
            trial.checking = true;
            Some((trial.id.clone(), trial.dir.clone()))
        }
        _ => None,
    }
}

/// The checks are over: committed or not, the next `ship_ready` may start them again unless this build committed.
fn end_checks(trial: &Mutex<Option<TrialState>>, committed: bool) {
    let mut trial = trial.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(trial) = trial.as_mut() {
        trial.committed |= committed;
        trial.checking = false;
    }
}

/// Write `committed.json`. A write that fails ends this round of checks uncommitted, so the next `ship_ready` tries
/// again (the runner rolls back if none succeeds in time).
fn record_commit(
    trial: &Mutex<Option<TrialState>>,
    dir: &Path,
    note: &Value,
) -> Result<(), String> {
    let written = write_json(&dir.join(COMMITTED), note);
    end_checks(trial, written.is_ok());
    written
}

fn run_trial_checks(app: &AppHandle, id: &str, dir: &Path) {
    let db = check_database(app);
    // WP-04 retired the Ash OS bridge, so the trial no longer waits on it.
    let checks = json!({
        "window": true,
        "database": match &db { Ok(sessions) => json!({"ok": true, "sessions": sessions}), Err(e) => json!({"ok": false, "error": e}) },
    });
    if db.is_err() {
        log(dir, &format!("trial checks failed: {checks}"));
        let _ = write_json(&dir.join(TRIAL_CHECKS), &checks);
        end_checks(&TRIAL, false);
        return;
    }
    let stamp = instance::stamp();
    let pid = std::process::id();
    let note = json!({
        "id": id,
        "sha": stamp.sha,
        "branch": stamp.branch,
        "pid": pid,
        "at": now_iso(),
        "checks": checks,
    });
    // WP-78: the trial row is written only after committed.json lands.
    if let Err(error) = commit_and_note_trial(&TRIAL, dir, &note) {
        log(dir, &format!("couldn't write {COMMITTED}: {error}"));
        return;
    }
    log(dir, "committed");
    // The runner writes it down; if it is gone, this app does.
    if let Ok(lock) = InstanceLock::acquire_file(&dir.join(RUNNER_LOCK), Duration::ZERO) {
        if let Ok(mut ship) = Ship::load(dir) {
            if ship.phase().is_some_and(|phase| !phase.is_final()) {
                finish_commit(&mut ship, "app");
            }
        }
        drop(lock);
    }
    let _ = app.emit(EVENT_CHANGED, status());
}

fn check_database(app: &AppHandle) -> Result<i64, String> {
    let store = app
        .try_state::<crate::session_store::SessionStore>()
        .ok_or("The database isn't open.")?;
    let conn = store.lock_conn()?;
    conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .map_err(|error| format!("The database didn't answer: {error}"))
}

// ---- the watcher (the app being replaced) ----------------------------------------------------------------------------

struct Pending {
    id: String,
    exempt: Option<String>,
    force: bool,
    next_try: Instant,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// From setup, daily app only: remember the trial (if any) and watch `ship/current.json` for a staged build.
pub fn init(app: &AppHandle, data: PathBuf, boot: Boot) {
    if instance::kind() != Kind::Daily {
        return;
    }
    let _ = DATA_DIR.set(data);
    if let Boot::Trial { id, dir } = boot {
        *TRIAL.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(TrialState {
            id,
            dir,
            committed: false,
            checking: false,
        });
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            tick(&app, &mut last);
            std::thread::sleep(WATCH_EVERY);
        }
    });
}

fn tick(app: &AppHandle, last: &mut String) {
    if let Some(data) = DATA_DIR.get() {
        if let Some(id) = current_id(data) {
            if let Ok(ship) = Ship::load(&ship_dir(data, &id)) {
                match ship.phase() {
                    Some(Phase::Staged | Phase::Waiting) if !holding() => consider(&ship),
                    _ => {
                        let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
                        if pending.as_ref().is_some_and(|p| p.id == id) {
                            *pending = None;
                        }
                    }
                }
            }
        }
    }
    try_pending_quit(app);
    let now = status();
    let signature = now.to_string();
    if *last != signature {
        *last = signature;
        let _ = app.emit(EVENT_CHANGED, now);
    }
}

/// Accept the staged build once (or refuse it, with why), then wait for a quiet moment to quit for it.
fn consider(ship: &Ship) {
    let accepted = ship.dir.join(ACCEPTED);
    let refused = ship.dir.join(REFUSED);
    if refused.exists() {
        return;
    }
    if !accepted.exists() {
        match verify_staged(ship) {
            Ok(()) => {
                let stamp = instance::stamp();
                let note = json!({
                    "pid": std::process::id(),
                    "sha": stamp.sha,
                    "at": now_iso(),
                });
                if write_json(&accepted, &note).is_err() {
                    return;
                }
                log(&ship.dir, "accepted the staged build");
            }
            Err(reason) => {
                let _ = write_json(&refused, &json!({ "reason": reason, "at": now_iso() }));
                log(&ship.dir, &format!("refused the staged build: {reason}"));
                return;
            }
        }
    }
    let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
    if pending.as_ref().is_none_or(|p| p.id != ship.id()) {
        *pending = Some(Pending {
            id: ship.id().into(),
            exempt: ship
                .doc
                .pointer("/requestedBy/sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            force: ship.text("/whenBusy") == "restart",
            next_try: Instant::now(),
        });
    }
}

fn try_pending_quit(app: &AppHandle) {
    let update = {
        let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
        match pending.as_mut() {
            Some(pending) if Instant::now() >= pending.next_try => {
                pending.next_try = Instant::now() + RETRY_QUIT_EVERY;
                Some(crate::window::UpdateQuit {
                    ship_id: pending.id.clone(),
                    exempt: pending.exempt.clone(),
                    force: pending.force,
                })
            }
            _ => None,
        }
    };
    if let Some(update) = update {
        crate::window::request_update_quit(app, update);
    }
}

/// The quit for update found other turns running; the watcher asks again in a few seconds.
pub fn update_deferred(ship_id: &str, in_flight: u32) {
    if let (Some(data), true) = (DATA_DIR.get(), in_flight > 0) {
        let dir = ship_dir(data, ship_id);
        let marker = dir.join("deferred.json");
        let _ = write_json(&marker, &json!({ "inFlight": in_flight, "at": now_iso() }));
    }
}

/// "Restart now": quit for the pending update even though turns are running (they resume afterwards).
#[tauri::command]
pub fn ship_restart_now(app: AppHandle) -> Result<(), String> {
    {
        let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
        let Some(pending) = pending.as_mut() else {
            return Err("There's no update waiting.".into());
        };
        pending.force = true;
        pending.next_try = Instant::now();
    }
    try_pending_quit(&app);
    Ok(())
}

/// The staged build must carry this app's own signature (same designated requirement, not ad hoc) and verify.
fn verify_staged(ship: &Ship) -> Result<(), String> {
    let name = ship
        .app_path()
        .file_name()
        .map(|name| name.to_os_string())
        .ok_or("The ship names no app.")?;
    let staged = ship.dir.join(STAGED_DIR).join(name);
    if !staged.is_dir() {
        return Err(format!("There's no staged build at {}", staged.display()));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let own = instance::bundle_of(&exe).ok_or("This app isn't running from a bundle.")?;
    let mine = designated_requirement(&own)?;
    let theirs = designated_requirement(&staged)?;
    if mine.contains("cdhash") || theirs.contains("cdhash") {
        return Err("An ad-hoc signature can't be checked against this app's.".into());
    }
    if mine != theirs {
        return Err(format!(
            "Its signature differs from this app's: \"{theirs}\" instead of \"{mine}\"."
        ));
    }
    let verified = Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict", "--deep"])
        .arg(&staged)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if !verified.success() {
        return Err("Its signature doesn't verify.".into());
    }
    Ok(())
}

fn designated_requirement(app: &Path) -> Result<String, String> {
    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "-r-"])
        .arg(app)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("codesign: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find_map(|line| line.trim().strip_prefix("designated => "))
        .map(str::to_string)
        .ok_or_else(|| format!("{} has no designated requirement.", app.display()))
}

// ---- what the window sees --------------------------------------------------------------------------------------------

/// `{enabled, holding, trial, pending, current}`: the newest ship and its receipt, the update waiting for a quiet
/// moment, and whether this build is on trial.
pub fn status() -> Value {
    let enabled = instance::kind() == Kind::Daily && DATA_DIR.get().is_some();
    let trial = TRIAL.lock().ok().and_then(|trial| {
        trial
            .as_ref()
            .map(|t| json!({ "id": t.id, "committed": t.committed }))
    });
    let pending = PENDING.lock().ok().and_then(|pending| {
        pending
            .as_ref()
            .map(|p| json!({ "id": p.id, "force": p.force, "exempt": p.exempt }))
    });
    let current = DATA_DIR
        .get()
        .and_then(|data| current_id(data).map(|id| summary(&ship_dir(data, &id))));
    json!({
        "enabled": enabled,
        "holding": holding(),
        "trial": trial,
        "pending": pending,
        "current": current,
    })
}

fn summary(dir: &Path) -> Value {
    let Ok(ship) = Ship::load(dir) else {
        return Value::Null;
    };
    let field = |key: &str| ship.doc.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": ship.id(),
        "kind": field("kind"),
        "phase": field("phase"),
        "reason": field("reason"),
        "from": field("from"),
        "to": field("to"),
        "requestedBy": field("requestedBy"),
        "whenBusy": field("whenBusy"),
        "drill": field("drill"),
        "createdAt": field("createdAt"),
        "updatedAt": field("updatedAt"),
        "accepted": dir.join(ACCEPTED).is_file(),
        "acceptance": acceptance(dir),
        "refused": read_json(&dir.join(REFUSED)).and_then(|r| r.get("reason").cloned()),
        "deferred": read_json(&dir.join("deferred.json")),
        "committed": dir.join(COMMITTED).is_file(),
        "receipt": read_json(&dir.join(RECEIPT)),
        "seen": dir.join(SEEN).is_file(),
        "shipDir": dir,
        "log": dir.join(RUNNER_LOG),
        "receiptPath": dir.join(RECEIPT),
    })
}

#[tauri::command]
pub fn ship_status() -> Value {
    status()
}

/// One ship's summary and receipt, for the resume note of a turn that ship cut.
#[tauri::command]
pub fn ship_receipt(id: String) -> Option<Value> {
    if !valid_id(&id) {
        return None;
    }
    let dir = ship_dir(DATA_DIR.get()?, &id);
    dir.is_dir().then(|| summary(&dir))
}

/// Ash has read the receipt in Today.
#[tauri::command]
pub fn ship_seen(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Not a ship id.".into());
    }
    let data = DATA_DIR.get().ok_or("Ship isn't on in this copy.")?;
    let dir = ship_dir(data, &id);
    if !dir.is_dir() {
        return Err("No such ship.".into());
    }
    write_json(&dir.join(SEEN), &json!({ "at": now_iso() }))?;
    let _ = app.emit(EVENT_CHANGED, status());
    Ok(())
}

// ---- Ash's acceptance (I4) ---------------------------------------------------------------------------------------

/// One ship's answer. A fresh ship is pending: the trial commit says the app opened, not that Ash used it and found
/// it working, so nothing here treats the two as the same.
pub fn acceptance(dir: &Path) -> Value {
    match read_json(&dir.join(ACCEPTANCE)) {
        Some(doc) if matches!(doc.get("state").and_then(Value::as_str), Some("yes" | "no")) => doc,
        _ => json!({ "state": "pending" }),
    }
}

/// Ash's answer about a committed ship. Kept in the ship's own folder, beside the receipt it answers; a refused or
/// uncommitted ship has nothing to answer, and "pending" is what no answer means, never a state to write.
pub fn record_acceptance(
    dir: &Path,
    verdict: &str,
    note: Option<&str>,
    by: &str,
) -> Result<Value, String> {
    if !matches!(verdict, "yes" | "no") {
        return Err("The answer is either yes or no.".into());
    }
    let ship = Ship::load(dir)?;
    if ship.phase() != Some(Phase::Committed) || !dir.join(COMMITTED).is_file() {
        return Err("This ship didn't commit, so there's no update to answer for.".into());
    }
    let note = note.map(str::trim).filter(|note| !note.is_empty());
    if note.is_some_and(|note| note.chars().count() > 2000) {
        return Err("The note is too long (2000 characters at most).".into());
    }
    let value = json!({
        "ship": ship.id(),
        "state": verdict,
        "note": note,
        "sha": ship.new_sha(),
        "branch": ship.doc.pointer("/to/branch").cloned().unwrap_or(Value::Null),
        "at": now_iso(),
        "by": by,
    });
    write_json(&dir.join(ACCEPTANCE), &value)?;
    Ok(value)
}

/// The row in the app's database. Added in place rather than as a numbered migration, so an older build (a ship
/// rollback) still opens this database; the ship folder stays the record that decides what Today shows.
pub(crate) fn ensure_acceptance_table(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ship_acceptance (
           ship_id TEXT PRIMARY KEY,
           verdict TEXT NOT NULL,
           note TEXT,
           sha TEXT,
           branch TEXT,
           answered_by TEXT,
           at TEXT NOT NULL
         );",
    )
}

fn upsert_acceptance(conn: &rusqlite::Connection, value: &Value) -> rusqlite::Result<usize> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    conn.execute(
        "INSERT INTO ship_acceptance (ship_id, verdict, note, sha, branch, answered_by, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(ship_id) DO UPDATE SET
           verdict = excluded.verdict, note = excluded.note, sha = excluded.sha,
           branch = excluded.branch, answered_by = excluded.answered_by, at = excluded.at",
        rusqlite::params![
            text("ship"),
            text("state"),
            text("note"),
            text("sha"),
            text("branch"),
            text("by"),
            text("at")
        ],
    )
}

fn save_acceptance(
    store: &crate::session_store::SessionStore,
    value: &Value,
) -> Result<(), String> {
    let conn = store.lock_conn()?;
    upsert_acceptance(&conn, value)
        .map(|_| ())
        .map_err(|error| format!("Couldn't keep the answer in the app's records: {error}"))
}

/// The command line writes the app's database directly (no window), waiting on the running app rather than failing.
fn keep_acceptance(data: &Path, value: &Value) -> Result<(), String> {
    let path = data.join("monocode.db");
    let conn = rusqlite::Connection::open(&path).map_err(|error| error.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    ensure_acceptance_table(&conn).map_err(|error| error.to_string())?;
    upsert_acceptance(&conn, value)
        .map(|_| ())
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// Today: Ash answered the question the card asks once a ship commits.
#[tauri::command]
pub fn ship_accept(
    app: AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    id: String,
    verdict: String,
    note: Option<String>,
) -> Result<Value, String> {
    if instance::kind() != Kind::Daily {
        return Err(
            "Only the daily app keeps a ship's answer; a dev copy runs from its worktree (npm run hub:dev)."
                .into(),
        );
    }
    if !valid_id(&id) {
        return Err("Not a ship id.".into());
    }
    let data = DATA_DIR.get().ok_or("Ship isn't on in this copy.")?;
    let dir = ship_dir(data, &id);
    if !dir.is_dir() {
        return Err("No such ship.".into());
    }
    let value = record_acceptance(&dir, &verdict, note.as_deref(), "ash")?;
    save_acceptance(&store, &value)?;
    let _ = app.emit(EVENT_CHANGED, status());
    Ok(summary(&dir))
}

const ACCEPT_USAGE: &str = "usage: monocode accept [SHIP-ID] [--yes | --no] [--note TEXT] [--json]";

fn accept_usage(error: &str) -> i32 {
    eprintln!("monocode accept: {error}\n{ACCEPT_USAGE}");
    2
}

fn acceptance_label(value: &Value) -> String {
    match value
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("pending")
    {
        "yes" => "accepted: it works".into(),
        "no" => match value.get("note").and_then(Value::as_str) {
            Some(note) => format!("not accepted: something's wrong ({note})"),
            None => "not accepted: something's wrong".into(),
        },
        _ => "waiting for Ash's answer".into(),
    }
}

fn short_sha(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// `monocode accept [SHIP-ID] [--yes | --no] [--note TEXT] [--json]`: the same answer Today's card takes, from a
/// terminal. No id lists the ships and what Ash said about each; an id alone shows one. Writing a "yes" here is still
/// Ash's own answer, so it is always explicit: nothing answers for him.
pub fn accept_main(args: &[String]) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{ACCEPT_USAGE}");
        return 0;
    }
    if instance::kind() != Kind::Daily {
        eprintln!(
            "monocode accept: only the daily app keeps a ship's answer; a dev copy runs from its worktree (npm run hub:dev)."
        );
        return 1;
    }
    let mut id: Option<String> = None;
    let mut verdict: Option<&'static str> = None;
    let mut note: Option<String> = None;
    let mut json_out = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--yes" => verdict = Some("yes"),
            "--no" => verdict = Some("no"),
            "--note" => match iter.next() {
                Some(text) => note = Some(text.clone()),
                None => return accept_usage("--note needs the words"),
            },
            "--json" => json_out = true,
            other if other.starts_with('-') => {
                return accept_usage(&format!("unknown argument {other}"));
            }
            other if id.is_none() && valid_id(other) => id = Some(other.into()),
            other => return accept_usage(&format!("not a ship id: {other}")),
        }
    }
    if note.is_some() && verdict.is_none() {
        return accept_usage("--note goes with --yes or --no");
    }
    let Some(data) = instance::data_dir(instance::DAILY_IDENTIFIER) else {
        return accept_usage("no home folder");
    };
    let Some(id) = id else {
        if verdict.is_some() {
            return accept_usage("name the ship this answer is about");
        }
        return list_ships(&data, json_out);
    };
    let dir = ship_dir(&data, &id);
    if !dir.is_dir() {
        eprintln!(
            "monocode accept: no ship {id} in {}",
            data.join(SHIP_DIR).display()
        );
        return 1;
    }
    let Some(verdict) = verdict else {
        let answer = acceptance(&dir);
        if json_out {
            println!("{answer}");
        } else {
            println!("Ship {id}: {}.", acceptance_label(&answer));
        }
        return 0;
    };
    let value = match record_acceptance(&dir, verdict, note.as_deref(), "ash") {
        Ok(value) => value,
        Err(error) => {
            eprintln!("monocode accept: {error}");
            return 1;
        }
    };
    if let Err(error) = keep_acceptance(&data, &value) {
        eprintln!(
            "monocode accept: kept the answer in {}; it couldn't go in the app's records: {error}",
            dir.join(ACCEPTANCE).display()
        );
    }
    if json_out {
        println!("{value}");
    } else {
        println!("Ship {id}: {}.", acceptance_label(&value));
    }
    0
}

fn list_ships(data: &Path, json_out: bool) -> i32 {
    let ships = data.join(SHIP_DIR);
    let mut ids: Vec<String> = match std::fs::read_dir(&ships) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|name| valid_id(name))
            .collect(),
        Err(_) => Vec::new(),
    };
    ids.sort_by(|a, b| b.cmp(a));
    if json_out {
        let rows: Vec<Value> = ids
            .iter()
            .map(|id| {
                let dir = ship_dir(data, id);
                let ship = Ship::load(&dir).ok();
                json!({
                    "id": id,
                    "phase": ship.as_ref().and_then(|ship| ship.phase().map(Phase::name)),
                    "sha": ship.as_ref().map(Ship::new_sha),
                    "branch": ship.as_ref().and_then(|ship| ship.doc.pointer("/to/branch")),
                    "acceptance": acceptance(&dir),
                })
            })
            .collect();
        println!("{}", Value::Array(rows));
        return 0;
    }
    if ids.is_empty() {
        println!("No ships yet.");
        return 0;
    }
    let lines: Vec<String> = ids
        .iter()
        .map(|id| {
            let dir = ship_dir(data, id);
            let ship = Ship::load(&dir).ok();
            let phase = ship
                .as_ref()
                .and_then(Ship::phase)
                .map(Phase::name)
                .unwrap_or("unreadable");
            let sha = ship
                .as_ref()
                .map(|ship| short_sha(ship.new_sha()))
                .unwrap_or("");
            let branch = ship
                .as_ref()
                .and_then(|ship| ship.doc.pointer("/to/branch").and_then(Value::as_str))
                .unwrap_or("");
            format!(
                "{id}  {phase:<8} {sha} {branch}  {}",
                acceptance_label(&acceptance(&dir))
            )
        })
        .collect();
    println!("{}", lines.join("\n"));
    0
}

/// `app.ship`: run `scripts/hub-ship.mjs` from the asking session's checkout, on its behalf. It checks, stages and
/// schedules, and returns within seconds; this app then quits for the update when it's quiet, and that session's turn
/// resumes with the receipt. `ash_tap` is set only by Ash's Apply (`self_build`) or a tap in the app. A chat's
/// `app.ship` leaves it unset.
#[tauri::command(async)]
pub fn ship_start(
    repo: String,
    requested_by: Option<String>,
    when_busy: Option<String>,
    ash_tap: Option<bool>,
) -> Result<Value, String> {
    let sandbox_on =
        crate::agent_sandbox::enabled(instance::data_dir(instance::DAILY_IDENTIFIER).as_deref());
    if agent_ship_refused(sandbox_on, ash_tap.unwrap_or(false)) {
        return Err(
            "Ship from a chat is refused while the agent sandbox is on. Use Apply in the app."
                .into(),
        );
    }
    if instance::kind() != Kind::Daily {
        return Err(
            "Only the daily app takes a ship; a dev copy runs from its worktree (npm run hub:dev)."
                .into(),
        );
    }
    let repo = PathBuf::from(&repo);
    if !repo.is_absolute() {
        return Err("The checkout must be an absolute path.".into());
    }
    let repo = repo
        .canonicalize()
        .map_err(|error| format!("{}: {error}", repo.display()))?;
    let script = repo.join("scripts/hub-ship.mjs");
    let manifest = std::fs::read_to_string(repo.join("package.json")).unwrap_or_default();
    let named = serde_json::from_str::<Value>(&manifest)
        .ok()
        .and_then(|value| {
            value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    if !script.is_file() || named.as_deref() != Some("monocode-desktop") {
        return Err(format!(
            "{} isn't a MonoCode Hub checkout with scripts/hub-ship.mjs.",
            repo.display()
        ));
    }
    let tidy = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    };
    let path = crate::harness::login_shell_path()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let node = std::env::split_paths(&path)
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
        .ok_or("Couldn't find node on the login shell's PATH.")?;
    let mut command = Command::new(node);
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(&script)
        .arg("--json")
        .current_dir(&repo)
        .env("PATH", &path)
        // The app asked (app.ship, self-build Apply): a version that wasn't bumped only warns (hub-ship.mjs, r59).
        // An env var, so an older checkout's hub-ship.mjs simply ignores it.
        .env("MONOCODE_SHIP_FROM_APP", "1")
        .stdin(Stdio::null());
    if let Some(session) = requested_by.as_deref() {
        if !tidy(session) {
            return Err("Not a session id.".into());
        }
        command.args(["--requested-by", session]);
    }
    if let Some(when) = when_busy.as_deref() {
        if when != "wait" && when != "restart" {
            return Err("whenBusy is \"wait\" or \"restart\".".into());
        }
        command.args(["--when-busy", when]);
    }
    let output = output_within(command, SHIP_START_LIMIT, "hub-ship.mjs")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let answer = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            format!(
                "hub-ship.mjs gave no answer: {}",
                stderr.lines().last().unwrap_or("")
            )
        })?;
    if output.status.success() && answer.get("ok").and_then(Value::as_bool) == Some(true) {
        // WP-78: hub-ship accepted it. The build is not in place yet, and a refusal writes nothing.
        let target = answer.get("id").and_then(Value::as_str).unwrap_or("");
        note_accepted_ship(
            true,
            instance::data_dir(instance::DAILY_IDENTIFIER).as_deref(),
            requested_by.as_deref(),
            target,
        );
        if valid_id(target) {
            if let Some(data) = instance::data_dir(instance::DAILY_IDENTIFIER) {
                let dir = ship_dir(&data, target);
                if let Ok(ship) = Ship::load(&dir) {
                    sign_ship_record(&ship)?;
                }
            }
        }
        Ok(answer)
    } else {
        let refusals = answer
            .get("refusals")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|text| !text.is_empty());
        Err(refusals
            .or_else(|| {
                answer
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "The ship was refused.".into()))
    }
}

// ---- small helpers ---------------------------------------------------------------------------------------------------

/// How long `app.ship` waits for `hub-ship.mjs`, which checks, stages and schedules (seconds, normally). Above the
/// script's own 300 s healthcheck of the new build plus staging, so a slow but healthy check is never cut off.
const SHIP_START_LIMIT: Duration = Duration::from_secs(420);

/// Run `command` to the end and collect what it printed, or stop it and everything it started (its own process group)
/// once `limit` has passed.
fn output_within(
    mut command: Command,
    limit: Duration,
    what: &str,
) -> Result<std::process::Output, String> {
    use std::io::Read;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    ];
    for (which, pipe) in pipes.into_iter().enumerate() {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            let _ = sender.send((which, bytes));
        });
    }
    drop(sender);
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{what} didn't finish within {} s, so it was stopped. Run it from the checkout to see why.",
                    limit.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(error.to_string()),
        }
    };
    let mut output = std::process::Output {
        status,
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    // Something it left running may hold a pipe open: read what is there, never wait on it for long.
    for _ in 0..2 {
        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok((0, bytes)) => output.stdout = bytes,
            Ok((_, bytes)) => output.stderr = bytes,
            Err(_) => break,
        }
    }
    Ok(output)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = path.with_file_name(format!(
        ".{}.{}",
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id()
    ));
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

fn log(dir: &Path, line: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(RUNNER_LOG))
    {
        let _ = writeln!(file, "{} [app {}] {line}", now_iso(), std::process::id());
    }
}

/// `2026-10-19T21:04:05.123Z`, what the runner writes too (`Date.prototype.toISOString`).
pub fn now_iso() -> String {
    iso(SystemTime::now())
}

fn iso(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs() as i64;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm), as in build.rs.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60,
        since.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("monocode-ship-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn facts(phase: Phase) -> Facts {
        Facts {
            phase,
            old_moved: false,
            new_moved: false,
            db_replaced: false,
            committed: false,
            runner_alive: false,
            me: Me::Old,
            trial_starts: 0,
            reason: None,
        }
    }

    #[test]
    fn a_finished_ship_changes_nothing_at_startup() {
        for phase in [
            Phase::Committed,
            Phase::RolledBack,
            Phase::Cancelled,
            Phase::Failed,
        ] {
            for alive in [false, true] {
                let f = Facts {
                    runner_alive: alive,
                    ..facts(phase)
                };
                assert_eq!(plan(&f), Plan::Normal, "{phase:?}");
            }
        }
    }

    #[test]
    fn with_its_runner_alive_the_app_stays_out_of_its_way() {
        let alive = |phase, me| Facts {
            runner_alive: true,
            me,
            ..facts(phase)
        };
        // Waiting for this app to quit: run normally, the watcher quits for the update.
        assert_eq!(plan(&alive(Phase::Staged, Me::Old)), Plan::Normal);
        assert_eq!(plan(&alive(Phase::Waiting, Me::Old)), Plan::Normal);
        // The new build opened by the runner: on trial.
        assert_eq!(plan(&alive(Phase::Trial, Me::New)), Plan::Trial);
        // Files are moving: don't touch them.
        assert_eq!(plan(&alive(Phase::Swapping, Me::Old)), Plan::Leave);
        assert_eq!(plan(&alive(Phase::RollingBack, Me::New)), Plan::Leave);
        assert_eq!(plan(&alive(Phase::Trial, Me::Old)), Plan::Leave);
        // Committed while the runner still runs: it writes it down.
        let committed = Facts {
            committed: true,
            ..alive(Phase::Trial, Me::New)
        };
        assert_eq!(plan(&committed), Plan::Normal);
    }

    #[test]
    fn a_runner_that_died_before_the_swap_calls_the_ship_off() {
        assert!(matches!(plan(&facts(Phase::Staged)), Plan::Cancel(_)));
        assert!(matches!(plan(&facts(Phase::Waiting)), Plan::Cancel(_)));
        // Mid-swap with nothing moved yet (the backup may be done): the old app is still in place.
        assert!(matches!(plan(&facts(Phase::Swapping)), Plan::Cancel(_)));
        // The old app out and the new one not in: nothing can be running from there; only the runner finishes it.
        let half = Facts {
            old_moved: true,
            ..facts(Phase::Swapping)
        };
        assert_eq!(plan(&half), Plan::Leave);
    }

    #[test]
    fn a_trial_with_nobody_watching_goes_on_three_times_then_rolls_back() {
        // The swap finished but the runner died before opening it: the user opened the new build.
        let swapped = Facts {
            old_moved: true,
            new_moved: true,
            me: Me::New,
            ..facts(Phase::Swapping)
        };
        assert_eq!(plan(&swapped), Plan::Trial);
        for starts in 0..MAX_TRIAL_STARTS {
            let f = Facts {
                me: Me::New,
                trial_starts: starts,
                ..facts(Phase::Trial)
            };
            assert_eq!(plan(&f), Plan::Trial, "start {starts}");
        }
        let looping = Facts {
            me: Me::New,
            trial_starts: MAX_TRIAL_STARTS,
            ..facts(Phase::Trial)
        };
        assert!(matches!(plan(&looping), Plan::Restore(_)));
        // It committed but the runner died before writing it down.
        let committed = Facts {
            committed: true,
            me: Me::New,
            ..facts(Phase::Trial)
        };
        assert_eq!(plan(&committed), Plan::FinishCommit);
        // Some other build entirely: leave it.
        let other = Facts {
            me: Me::Other,
            ..facts(Phase::Trial)
        };
        assert_eq!(plan(&other), Plan::Leave);
    }

    #[test]
    fn a_restore_cut_short_is_finished_by_whichever_build_starts() {
        for me in [Me::New, Me::Old] {
            let f = Facts {
                me,
                reason: Some("No commit within 120 s.".into()),
                ..facts(Phase::RollingBack)
            };
            assert_eq!(plan(&f), Plan::Restore("No commit within 120 s.".into()));
        }
        let other = Facts {
            me: Me::Other,
            ..facts(Phase::RollingBack)
        };
        assert_eq!(plan(&other), Plan::Leave);
    }

    #[test]
    fn a_commit_that_couldnt_be_written_is_tried_again() {
        let root = TempDir::new("commit");
        let trial = Mutex::new(Some(TrialState {
            id: "20261019-210405-bbbbbbb".into(),
            // No such folder: writing committed.json fails.
            dir: root.0.join("gone"),
            committed: false,
            checking: false,
        }));
        let (_, dir) = begin_checks(&trial).expect("the first ship_ready starts the checks");
        assert!(begin_checks(&trial).is_none(), "one round at a time");
        assert!(record_commit(&trial, &dir, &json!({})).is_err());
        let (_, dir) = begin_checks(&trial).expect("the next ship_ready tries again");
        std::fs::create_dir_all(&dir).unwrap();
        record_commit(&trial, &dir, &json!({})).unwrap();
        assert!(dir.join(COMMITTED).is_file());
        assert!(begin_checks(&trial).is_none(), "committed: no more checks");
        assert!(trial.lock().unwrap().as_ref().unwrap().committed);
    }

    #[test]
    fn the_ship_script_gets_a_deadline() {
        // `output_within` runs on every platform; the scripts are `/bin/sh` here and `cmd` on Windows.
        #[cfg(not(windows))]
        let (command, newline) = {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "echo out; echo err >&2"]);
            (command, "\n")
        };
        #[cfg(windows)]
        let (command, newline) = {
            let mut command = Command::new("cmd");
            command.args(["/d", "/c", "echo out& echo err>&2"]);
            (command, "\r\n")
        };
        let output = output_within(command, Duration::from_secs(20), "the script").unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, format!("out{newline}").into_bytes());
        assert_eq!(output.stderr, format!("err{newline}").into_bytes());

        // One that hangs is stopped at the limit, with whatever it started.
        let root = TempDir::new("deadline");
        let pid_file = root.0.join("sleeper.pid");
        #[cfg(not(windows))]
        let command = {
            let mut command = Command::new("/bin/sh");
            command.args([
                "-c",
                &format!("sleep 60 & echo $! > '{}'; wait", pid_file.display()),
            ]);
            command
        };
        #[cfg(windows)]
        let command = {
            let _ = &pid_file;
            let mut command = Command::new("cmd");
            command.args(["/d", "/c", "ping -n 60 127.0.0.1 >nul"]);
            command
        };
        let started = Instant::now();
        let error = output_within(command, Duration::from_millis(800), "hub-ship.mjs").unwrap_err();
        assert!(
            error.contains("hub-ship.mjs didn't finish within"),
            "{error}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        #[cfg(unix)]
        {
            let sleeper: i32 = std::fs::read_to_string(&pid_file)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while unsafe { libc::kill(sleeper, 0) } == 0 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert_ne!(
                unsafe { libc::kill(sleeper, 0) },
                0,
                "what it started is stopped too"
            );
        }
    }

    #[test]
    fn which_build_this_is_comes_from_the_stamp() {
        assert_eq!(me_for("b", "b", "a"), Me::New);
        assert_eq!(me_for("a", "b", "a"), Me::Old);
        assert_eq!(me_for("c", "b", "a"), Me::Other);
        assert_eq!(me_for("", "", ""), Me::Other);
    }

    #[test]
    fn ship_ids_never_leave_the_ship_folder() {
        for good in [
            "20261019-210405-abc1234",
            "20261019-210405-abc1234-rollback",
        ] {
            assert!(valid_id(good), "{good}");
        }
        for bad in ["", "..", "../x", "a/b", ".hidden", "a b", &"a".repeat(97)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    /// A ship folder after the runner swapped the apps: the new build in place, the old one in previous.app.off, the
    /// database backed up, and the new build has since written to the live database.
    fn swapped_fixture(root: &Path) -> (Ship, PathBuf) {
        let home = root.join("home");
        let app = home.join("Applications/MonoCode Hub.app");
        let data = home.join("Library/Application Support/com.ash.monocode-hub");
        let dir = data.join(SHIP_DIR).join("20261019-210405-bbbbbbb");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/monocode"), b"new build").unwrap();
        let previous = dir.join(PREVIOUS_APP);
        std::fs::create_dir_all(previous.join("Contents/MacOS")).unwrap();
        std::fs::write(previous.join("Contents/MacOS/monocode"), b"old build").unwrap();
        // The backup, taken after the old app quit.
        let backup = dir.join(BACKUP_DIR);
        std::fs::create_dir_all(backup.join("monos/ed")).unwrap();
        std::fs::write(backup.join("monocode.db"), b"old database").unwrap();
        std::fs::write(backup.join("monocode.db-wal"), b"old wal").unwrap();
        std::fs::write(backup.join("monos/ed/SOUL.md"), b"old soul").unwrap();
        // What the new build did to the live data during its trial.
        std::fs::create_dir_all(data.join("monos/ed")).unwrap();
        std::fs::write(data.join("monocode.db"), b"migrated by the new build").unwrap();
        std::fs::write(data.join("monocode.db-shm"), b"new shm").unwrap();
        std::fs::write(data.join("monos/ed/SOUL.md"), b"new soul").unwrap();
        let db = sha256_file(&backup.join("monocode.db")).unwrap();
        let wal = sha256_file(&backup.join("monocode.db-wal")).unwrap();
        let doc = json!({
            "version": 1,
            "id": "20261019-210405-bbbbbbb",
            "kind": "ship",
            "phase": "rolling-back",
            "reason": "No commit within 120 s.",
            "appPath": app,
            "dataDir": data,
            "to": {"sha": "b".repeat(40)},
            "from": {"sha": "a".repeat(40)},
            "steps": {"backup": "t", "oldMoved": "t", "newMoved": "t", "launched": "t", "stopped": "t"},
            "db": {"backup": {"monocode.db": db, "monocode.db-wal": wal}},
        });
        write_json(&dir.join(STATE), &doc).unwrap();
        (Ship::load(&dir).unwrap(), app)
    }

    #[test]
    fn the_new_build_puts_the_old_one_and_its_database_back() {
        let root = TempDir::new("restore");
        let (mut ship, app) = swapped_fixture(&root.0);
        restore(&mut ship, Me::New).unwrap();
        let data = ship.data_dir();
        assert_eq!(
            std::fs::read(app.join("Contents/MacOS/monocode")).unwrap(),
            b"old build"
        );
        assert_eq!(
            std::fs::read(ship.dir.join(REJECTED_APP).join("Contents/MacOS/monocode")).unwrap(),
            b"new build"
        );
        assert_eq!(
            std::fs::read(data.join("monocode.db")).unwrap(),
            b"old database"
        );
        assert_eq!(
            std::fs::read(data.join("monocode.db-wal")).unwrap(),
            b"old wal"
        );
        assert!(
            !data.join("monocode.db-shm").exists(),
            "the backup had no shm"
        );
        assert_eq!(
            std::fs::read(data.join("monos/ed/SOUL.md")).unwrap(),
            b"old soul"
        );
        assert_eq!(
            std::fs::read(ship.dir.join(REJECTED_MONOS).join("ed/SOUL.md")).unwrap(),
            b"new soul"
        );
        let saved = Ship::load(&ship.dir).unwrap();
        for step in ["newRemoved", "oldRestored", "dbRestored"] {
            assert!(saved.step(step), "{step}");
        }
        assert_eq!(
            saved.doc.pointer("/db/restored/monocode.db"),
            saved.doc.pointer("/db/backup/monocode.db"),
            "byte for byte"
        );
    }

    fn activity_rows(db: &std::path::Path) -> Vec<crate::activity::Entry> {
        let store = crate::session_store::SessionStore::open(db.to_path_buf()).unwrap();
        let conn = store.lock_conn().unwrap();
        crate::activity::list(
            &conn,
            &crate::activity::ListQuery {
                limit: Some(20),
                ..Default::default()
            },
            crate::session_store::now_millis(),
        )
        .unwrap()
        .entries
    }

    #[test]
    fn a_started_ship_records_one_line_and_a_refusal_records_nothing() {
        let root = TempDir::new("ship-start");
        let data = root.0.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let db = data.join("monocode.db");
        {
            let _store = crate::session_store::SessionStore::open(db.clone()).unwrap();
        }
        note_accepted_ship(false, Some(&data), Some("lead-1"), "refused");
        note_accepted_ship(true, None, Some("lead-1"), "no-folder");
        assert!(
            activity_rows(&db).is_empty(),
            "a refusal or a missing data folder writes nothing"
        );
        note_accepted_ship(true, Some(&data), Some("  lead-1  "), "ship-1");
        let rows = activity_rows(&db);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].kind, crate::activity::SHIP);
        assert_eq!(rows[0].actor, crate::activity::Who::app());
        assert_eq!(
            rows[0].initiator,
            crate::activity::Who::first_mate("lead-1", "")
        );
        assert_eq!(rows[0].target, "ship-1");
        assert_eq!(rows[0].summary, "Started a ship.");
        note_accepted_ship(true, Some(&data), None, "ship-2");
        let rows = activity_rows(&db);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0].initiator, crate::activity::Who::person());
        assert_eq!(rows[0].summary, "Started a ship.");
    }

    #[test]
    fn a_committed_trial_records_one_line_and_a_second_check_does_not_run() {
        let root = TempDir::new("trial-note");
        let data = root.0.join("data");
        let dir = root.0.join("ship");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let db = data.join("monocode.db");
        {
            let _store = crate::session_store::SessionStore::open(db.clone()).unwrap();
        }
        let id = "20261019-210405-trial01";
        write_json(
            &dir.join(STATE),
            &json!({
                "version": 1,
                "id": id,
                "kind": "ship",
                "phase": "trial",
                "dataDir": data.to_string_lossy(),
                "requestedBy": { "sessionId": "lead-1" },
            }),
        )
        .unwrap();
        let trial = Mutex::new(Some(TrialState {
            id: id.to_string(),
            dir: dir.clone(),
            committed: false,
            checking: false,
        }));
        assert!(begin_checks(&trial).is_some());
        assert!(
            commit_and_note_trial(&trial, &dir, &json!({ "id": id })).is_ok(),
            "the commit has to land before the activity row"
        );
        assert!(
            begin_checks(&trial).is_none(),
            "a committed trial does not start its checks again"
        );
        let rows = activity_rows(&db);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].kind, crate::activity::SHIP_TRIAL);
        assert_eq!(rows[0].actor, crate::activity::Who::app());
        assert_eq!(
            rows[0].initiator,
            crate::activity::Who::first_mate("lead-1", "")
        );
        assert_eq!(rows[0].target, id);
        assert_eq!(rows[0].summary, "The new build's trial committed.");

        let blocked = root.0.join("not-a-directory");
        std::fs::write(&blocked, b"x").unwrap();
        let again = Mutex::new(Some(TrialState {
            id: id.to_string(),
            dir: blocked.clone(),
            committed: false,
            checking: false,
        }));
        assert!(begin_checks(&again).is_some());
        assert!(commit_and_note_trial(&again, &blocked, &json!({ "id": id })).is_err());
        assert_eq!(
            activity_rows(&db).len(),
            1,
            "a commit that did not land does not add a trial row"
        );
    }

    #[test]
    fn a_finished_rollback_records_one_line_and_a_dev_copy_records_nothing() {
        let root = TempDir::new("activity");
        let (mut ship, _) = swapped_fixture(&root.0);
        let own = instance::stamp().sha.clone();
        let to = "b".repeat(40);
        assert!(!own.is_empty());
        assert_ne!(own, to);
        assert_eq!(
            me_for(&own, &to, &own),
            Me::Old,
            "Me::New would exit the test process"
        );
        let seed = root.0.join("seed.db");
        {
            let store = crate::session_store::SessionStore::open(seed.clone()).unwrap();
            let conn = store.lock_conn().unwrap();
            let _: (i64, i64, i64) = conn
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .unwrap();
        }
        let backup = ship.dir.join(BACKUP_DIR).join("monocode.db");
        std::fs::copy(&seed, &backup).unwrap();
        // The fixture's wal is not this database. Leaving it out makes the restore drop any live wal.
        std::fs::remove_file(ship.dir.join(BACKUP_DIR).join("monocode.db-wal")).unwrap();
        let sum = sha256_file(&backup).unwrap();
        *ship.doc.pointer_mut("/from/sha").unwrap() = json!(own);
        *ship.doc.pointer_mut("/db/backup/monocode.db").unwrap() = json!(sum);
        ship.doc
            .pointer_mut("/db/backup")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("monocode.db-wal");
        ship.doc
            .as_object_mut()
            .unwrap()
            .insert("requestedBy".into(), json!({ "sessionId": "lead-1" }));
        ship.save().unwrap();
        // save does not sign. This record is one the app wrote, so startup may act on it.
        sign_ship_record(&ship).unwrap();
        let data = ship.data_dir();
        write_json(
            &data.join(SHIP_DIR).join(CURRENT),
            &json!({ "id": ship.id() }),
        )
        .unwrap();
        let dev = Identity {
            kind: Kind::Dev,
            identifier: "com.ash.monocode-hub.dev.wp78".into(),
            slot: Some("wp78".into()),
        };
        assert!(matches!(startup(&dev, &data), Boot::Normal));
        assert_eq!(
            std::fs::read(data.join("monocode.db")).unwrap(),
            b"migrated by the new build",
            "a dev copy does not roll a ship back"
        );
        let daily = Identity {
            kind: Kind::Daily,
            identifier: instance::DAILY_IDENTIFIER.into(),
            slot: None,
        };
        assert!(matches!(startup(&daily, &data), Boot::Normal));
        assert!(matches!(startup(&daily, &data), Boot::Normal));
        let store = crate::session_store::SessionStore::open(data.join("monocode.db")).unwrap();
        let conn = store.lock_conn().unwrap();
        let rows = crate::activity::list(
            &conn,
            &crate::activity::ListQuery {
                limit: Some(20),
                ..Default::default()
            },
            crate::session_store::now_millis(),
        )
        .unwrap()
        .entries;
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].kind, crate::activity::SHIP_ROLLBACK);
        assert_eq!(rows[0].actor, crate::activity::Who::app());
        assert_eq!(
            rows[0].initiator,
            crate::activity::Who::first_mate("lead-1", "")
        );
        assert_eq!(rows[0].target, "20261019-210405-bbbbbbb");
        assert_eq!(rows[0].summary, "Rolled back to the previous build.");
    }

    #[test]
    fn a_restore_interrupted_mid_way_finishes_on_the_next_start() {
        let root = TempDir::new("restart");
        let (mut ship, app) = swapped_fixture(&root.0);
        // The first try moved the new build aside and then died (a crash, a reboot).
        std::fs::rename(&app, ship.dir.join(REJECTED_APP)).unwrap();
        ship.mark_step("newRemoved");
        ship.save().unwrap();
        // Nothing is at the app's place now, so the next start can only be the runner or the old build once the
        // runner has put it back. Say the runner put it back and died before the database:
        std::fs::rename(ship.dir.join(PREVIOUS_APP), &app).unwrap();
        ship.mark_step("oldRestored");
        ship.save().unwrap();
        // The old build starts: its plan is to finish the restore, then run normally.
        let reloaded = Ship::load(&ship.dir).unwrap();
        let f = Facts {
            phase: reloaded.phase().unwrap(),
            old_moved: reloaded.step("oldMoved"),
            new_moved: reloaded.step("newMoved"),
            db_replaced: false,
            committed: false,
            runner_alive: false,
            me: Me::Old,
            trial_starts: 0,
            reason: Some("No commit within 120 s.".into()),
        };
        assert_eq!(plan(&f), Plan::Restore("No commit within 120 s.".into()));
        let mut reloaded = reloaded;
        restore(&mut reloaded, Me::Old).unwrap();
        assert_eq!(
            std::fs::read(app.join("Contents/MacOS/monocode")).unwrap(),
            b"old build"
        );
        assert_eq!(
            std::fs::read(reloaded.data_dir().join("monocode.db")).unwrap(),
            b"old database"
        );
        // Running it again changes nothing.
        restore(&mut reloaded, Me::Old).unwrap();
        assert_eq!(
            std::fs::read(app.join("Contents/MacOS/monocode")).unwrap(),
            b"old build"
        );
    }

    #[test]
    fn a_tampered_backup_fails_the_restore() {
        let root = TempDir::new("tampered");
        let (mut ship, _) = swapped_fixture(&root.0);
        // The second file is the bad one: the first must not have been put in place already.
        std::fs::write(
            ship.dir.join(BACKUP_DIR).join("monocode.db-wal"),
            b"changed",
        )
        .unwrap();
        let error = restore(&mut ship, Me::New).unwrap_err();
        assert!(error.contains("doesn't match its backup"), "{error}");
        assert!(!Ship::load(&ship.dir).unwrap().step("dbRestored"));
        let data = ship.data_dir();
        assert_eq!(
            std::fs::read(data.join("monocode.db")).unwrap(),
            b"migrated by the new build",
            "no live file changed"
        );
        assert_eq!(
            std::fs::read(data.join("monocode.db-shm")).unwrap(),
            b"new shm"
        );
        assert_eq!(
            std::fs::read(data.join("monos/ed/SOUL.md")).unwrap(),
            b"new soul"
        );
        assert!(!data.join(".monocode.db.restoring").exists());
    }

    #[test]
    fn a_backup_missing_a_file_it_took_fails_the_restore() {
        let root = TempDir::new("missing");
        let (ship, _) = swapped_fixture(&root.0);
        std::fs::remove_file(ship.dir.join(BACKUP_DIR).join("monocode.db")).unwrap();
        let error = restore_db(&ship).unwrap_err();
        assert!(error.contains("missing"), "{error}");
        assert_eq!(
            std::fs::read(ship.data_dir().join("monocode.db")).unwrap(),
            b"migrated by the new build"
        );
        std::fs::remove_dir_all(ship.dir.join(BACKUP_DIR)).unwrap();
        assert!(restore_db(&ship).unwrap_err().contains("missing"));
        assert!(ship.data_dir().join("monocode.db").exists());
        assert!(ship.data_dir().join("monos").exists());
    }

    #[test]
    fn a_rollback_cut_off_while_its_database_went_in_is_restored_not_called_off() {
        // hub:rollback's ship: the runner began putting the older database in place, then died before moving any app.
        let cut = Facts {
            db_replaced: true,
            ..facts(Phase::Swapping)
        };
        assert!(matches!(plan(&cut), Plan::Restore(_)), "{:?}", plan(&cut));
        let other = Facts {
            me: Me::Other,
            ..cut.clone()
        };
        assert_eq!(plan(&other), Plan::Leave);
    }

    #[test]
    fn the_receipt_names_what_runs_now() {
        let root = TempDir::new("receipt");
        let (mut ship, _) = swapped_fixture(&root.0);
        ship.set_phase(Phase::RolledBack, "back");
        let rolled = receipt(&ship, "app");
        assert_eq!(rolled["outcome"], "rolled-back");
        assert_eq!(rolled["running"]["sha"], "a".repeat(40));
        assert_eq!(rolled["reason"], "No commit within 120 s.");
        assert!(rolled["log"].as_str().unwrap().ends_with("runner.log"));
        ship.set_phase(Phase::Committed, "done");
        assert_eq!(receipt(&ship, "runner")["running"]["sha"], "b".repeat(40));
    }

    #[test]
    fn a_phase_is_written_as_the_runner_writes_it() {
        assert_eq!(
            serde_json::to_value(Phase::RollingBack).unwrap(),
            json!("rolling-back")
        );
        for phase in [
            Phase::Staged,
            Phase::Waiting,
            Phase::Swapping,
            Phase::Trial,
            Phase::Committed,
            Phase::RollingBack,
            Phase::RolledBack,
            Phase::Cancelled,
            Phase::Failed,
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), json!(phase.name()));
        }
    }

    #[test]
    fn timestamps_match_javascripts_iso_strings() {
        let at = UNIX_EPOCH + Duration::from_millis(1_792_443_845_123);
        assert_eq!(iso(at), "2026-10-19T21:04:05.123Z");
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    /// H-B: while the sandbox is on, a chat's app.ship does not run unless Ash tapped.
    #[test]
    fn an_agent_cannot_ship_while_the_sandbox_is_on() {
        assert!(
            agent_ship_refused(true, false),
            "an agent's app.ship must be refused while the sandbox is on"
        );
        assert!(!agent_ship_refused(true, true));
        assert!(!agent_ship_refused(false, false));
    }

    /// The mac covers the fields the runner must not change. A phase rewrite, which the runner does, still matches.
    /// A missing mac, or a changed app path or launch env, does not.
    #[cfg(unix)]
    #[test]
    fn a_signed_record_stays_ours_when_only_the_phase_changes() {
        use std::os::unix::fs::PermissionsExt;
        let root = TempDir::new("record-mac");
        let data = root.0.join("data");
        let dir = data.join(SHIP_DIR).join("20261111-120000-abc1234");
        let bin = root.0.join("bin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(dir.join("runner.mjs"), APP_RUNNER).unwrap();
        std::fs::write(dir.join("ship-platform.mjs"), APP_SHIP_PLATFORM).unwrap();
        let node = bin.join("node");
        std::fs::copy("/usr/bin/true", &node).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        write_json(
            &dir.join(STATE),
            &json!({
                "id": "20261111-120000-abc1234",
                "phase": "trial",
                "node": node.to_string_lossy(),
                "appPath": "/Applications/MonoCode Hub.app",
                "dataDir": data.to_string_lossy(),
                "home": "/Users/test",
                "launch": { "mode": "direct", "env": { "B": "2", "A": "1" } },
            }),
        )
        .unwrap();
        let unsigned = Ship::load(&dir).unwrap();
        assert!(
            !runner_record_is_ours(&unsigned),
            "a record with no mac is not one this app wrote"
        );
        sign_ship_record(&unsigned).unwrap();
        assert!(runner_record_is_ours(&Ship::load(&dir).unwrap()));
        let mut phased = Ship::load(&dir).unwrap();
        phased.set("phase", json!("committed"));
        phased.save().unwrap();
        assert!(
            runner_record_is_ours(&Ship::load(&dir).unwrap()),
            "the runner rewrites phase, and that must not break the mac"
        );
        let mut env = Ship::load(&dir).unwrap();
        *env.doc.pointer_mut("/launch/env/A").unwrap() = json!("9");
        env.save().unwrap();
        assert!(
            !runner_record_is_ours(&Ship::load(&dir).unwrap()),
            "a changed launch env must not still match"
        );
        sign_ship_record(&Ship::load(&dir).unwrap()).unwrap();
        let mut moved = Ship::load(&dir).unwrap();
        moved.set("appPath", json!("/tmp/Agent.app"));
        moved.save().unwrap();
        assert!(
            !runner_record_is_ours(&Ship::load(&dir).unwrap()),
            "a changed app path must not still match"
        );
    }

    /// A ship folder the way the runner leaves a committed one: state.json and committed.json.
    fn committed_ship(dir: &Path, id: &str) {
        std::fs::create_dir_all(dir).unwrap();
        write_json(
            &dir.join(STATE),
            &json!({
                "id": id,
                "phase": "committed",
                "from": { "sha": "a".repeat(40), "branch": "hub/from" },
                "to": { "sha": "b".repeat(40), "branch": "hub/to" },
            }),
        )
        .unwrap();
        write_json(&dir.join(COMMITTED), &json!({ "at": now_iso() })).unwrap();
    }

    #[test]
    fn a_fresh_ship_waits_for_ash_and_only_a_yes_or_a_no_is_an_answer() {
        let dir = TempDir::new("acceptance");
        committed_ship(&dir.0, "20261023-120000-abc1234");
        // The trial committed: the app opened. That is not Ash saying it works.
        assert_eq!(acceptance(&dir.0), json!({ "state": "pending" }));

        let yes = record_acceptance(&dir.0, "yes", None, "ash").unwrap();
        assert_eq!(yes["state"], "yes");
        assert_eq!(yes["ship"], "20261023-120000-abc1234");
        assert_eq!(yes["sha"], "b".repeat(40));
        assert_eq!(yes["branch"], "hub/to");
        assert_eq!(acceptance(&dir.0)["state"], "yes");

        // His answer can change, and the note with it.
        let no = record_acceptance(&dir.0, "no", Some("  the sidebar is blank  "), "ash").unwrap();
        assert_eq!(no["state"], "no");
        assert_eq!(no["note"], "the sidebar is blank");
        assert_eq!(acceptance(&dir.0), no);

        assert!(record_acceptance(&dir.0, "maybe", None, "ash").is_err());
        assert!(record_acceptance(&dir.0, "pending", None, "ash").is_err());
    }

    #[test]
    fn a_ship_that_did_not_commit_has_nothing_to_answer() {
        let dir = TempDir::new("acceptance-uncommitted");
        std::fs::create_dir_all(&dir.0).unwrap();
        write_json(
            &dir.0.join(STATE),
            &json!({ "id": "20261023-120000-abc1234", "phase": "rolled-back" }),
        )
        .unwrap();
        assert!(record_acceptance(&dir.0, "yes", None, "ash").is_err());
        assert!(!dir.0.join(ACCEPTANCE).is_file());
        assert_eq!(acceptance(&dir.0), json!({ "state": "pending" }));
    }

    #[test]
    fn the_database_row_follows_the_answer() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_acceptance_table(&conn).unwrap();
        let ship = json!({
            "ship": "20261023-120000-abc1234", "state": "yes", "note": null,
            "sha": "b".repeat(40), "branch": "hub/to", "at": now_iso(), "by": "ash",
        });
        upsert_acceptance(&conn, &ship).unwrap();
        let (verdict, note): (String, Option<String>) = conn
            .query_row(
                "SELECT verdict, note FROM ship_acceptance WHERE ship_id = ?1",
                ["20261023-120000-abc1234"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(verdict, "yes");
        assert_eq!(note, None);
        let mut no = ship.clone();
        no["state"] = json!("no");
        no["note"] = json!("crashes on launch");
        upsert_acceptance(&conn, &no).unwrap();
        let (verdict, note): (String, Option<String>) = conn
            .query_row(
                "SELECT verdict, note FROM ship_acceptance WHERE ship_id = ?1",
                ["20261023-120000-abc1234"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(verdict, "no");
        assert_eq!(note.as_deref(), Some("crashes on launch"));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ship_acceptance", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn the_runner_lock_is_one_holder_at_a_time() {
        let dir = TempDir::new("runner-lock");
        let held = InstanceLock::acquire_file(&dir.0.join(RUNNER_LOCK), Duration::ZERO).unwrap();
        assert!(InstanceLock::acquire_file(&dir.0.join(RUNNER_LOCK), Duration::ZERO).is_err());
        drop(held);
        assert!(InstanceLock::acquire_file(&dir.0.join(RUNNER_LOCK), Duration::ZERO).is_ok());
    }
}

/// Review r3 repro for PR #208 (WP-178). The sandbox profile protects only `settings/` and `monocode.db*` in the app's
/// data folder. A sandboxed agent can still write `ship/current.json` and a ship record of its own, and at the daily
/// app's next start `startup` restarts that record's "runner" with the record's own `node`, outside any sandbox. Red at
/// 4417a9621 (the profile half is `agent_sandbox::review_r3_repro::the_rest_of_the_data_folder_cannot_be_written`).
#[cfg(all(test, unix))]
mod review_r3_repro {
    use super::*;

    #[test]
    fn a_ship_record_an_agent_wrote_is_not_run_at_the_next_start() {
        use std::os::unix::fs::PermissionsExt;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let data = std::env::temp_dir().join(format!("ship-r3-{}-{nanos}", std::process::id()));
        let dir = data.join(SHIP_DIR).join("planted");
        std::fs::create_dir_all(&dir).unwrap();
        let marker = data.join("RAN-OUTSIDE-THE-SANDBOX");
        let program = dir.join("not-node.sh");
        std::fs::write(
            &program,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("runner.mjs"), "// the agent's runner\n").unwrap();
        // Everything below is what a sandboxed agent writes; it reads the running build's sha from `monocode version`.
        write_json(
            &dir.join(STATE),
            &json!({
                "id": "planted",
                "phase": "trial",
                "to": { "sha": instance::stamp().sha },
                "from": { "sha": "0000000" },
                "node": program.to_string_lossy(),
            }),
        )
        .unwrap();
        write_json(
            &data.join(SHIP_DIR).join(CURRENT),
            &json!({ "id": "planted" }),
        )
        .unwrap();

        let daily = Identity {
            kind: Kind::Daily,
            identifier: instance::DAILY_IDENTIFIER.into(),
            slot: None,
        };
        let _ = startup(&daily, &data);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let ran = marker.exists();
        let _ = std::fs::remove_dir_all(&data);
        assert!(
            !ran,
            "the daily app ran a ship record an agent planted in its data folder, outside the sandbox"
        );
    }
}

/// Review r4 repro for PR #208 (WP-178). 5eedc0d75 says startup "refuses a ship runner the app did not write", but the
/// proof is only things an agent can reproduce: the runner scripts are public (`scripts/hub-ship-runner.mjs` and
/// `scripts/ship-platform.mjs` are in the checkout it works in), `node` is any non-script file named `node` outside
/// the ship folder (a copied or compiled binary in `/tmp`), `dataDir` comes from the record itself, and nothing about
/// `state.json` is checked, while the genuine runner then opens the record's `appPath` (with `launch.env` in direct
/// mode). The data folder is write-denied, so this is the second line only (MED). Red at 5eedc0d75.
#[cfg(all(test, unix))]
mod review_r4_repro {
    use super::*;

    #[test]
    fn a_record_built_from_the_public_runner_and_an_agent_node_is_not_the_apps() {
        use std::os::unix::fs::PermissionsExt;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("ship-r4-{}-{nanos}", std::process::id()));
        let data = root.join("data");
        let dir = data.join(SHIP_DIR).join("planted");
        let elsewhere = root.join("agent-bin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        // Byte-for-byte the build's copies: the agent reads them from its own checkout.
        std::fs::write(dir.join("runner.mjs"), APP_RUNNER).unwrap();
        std::fs::write(dir.join("ship-platform.mjs"), APP_SHIP_PLATFORM).unwrap();
        // Any binary (not a `#!` script) named node, outside the ship folder.
        let node = elsewhere.join("node");
        std::fs::copy("/usr/bin/true", &node).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        write_json(
            &dir.join(STATE),
            &json!({
                "id": "planted",
                "phase": "trial",
                "to": { "sha": instance::stamp().sha },
                "from": { "sha": "0000000" },
                "node": node.to_string_lossy(),
                "appPath": root.join("Agent.app").to_string_lossy(),
                "launch": { "mode": "direct", "env": { "AGENT": "1" } },
            }),
        )
        .unwrap();
        let ship = Ship::load(&dir).unwrap();
        let ours = runner_record_is_ours(&ship);
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            !ours,
            "a record an agent can build (public runner copies, its own node, its own appPath) passes as the app's"
        );
    }
}

/// Review r5 repro for PR #208 (WP-178). The mac round 5 added (`record.mac`) is checked only in `restart_runner`. The
/// app's own startup `restore` and `reopen` act on `state.json` before and without it: a record with no mac, phase
/// `rolling-back` and `from.sha` set to this build's stamp (`monocode version` prints it) makes the daily app, outside
/// any sandbox, rename the ship folder's `previous.app.off` to the record's `appPath`. That path is any file name the
/// record chooses (a LaunchAgent plist here); with `to.sha` instead, `reopen` also runs `<appPath>`'s binary with the
/// record's `launch.env`. The data folder is write-denied, so this is the second line (MED1 still open). Red at
/// a5bc60a97.
#[cfg(all(test, unix))]
mod review_r5_repro {
    use super::*;

    #[test]
    fn startup_does_not_restore_from_a_record_this_app_did_not_sign() {
        let own = instance::stamp().sha.clone();
        // An empty stamp makes the plan Leave, which exits the test process: refuse to run instead.
        assert!(!own.is_empty(), "this test needs a build stamp");
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("ship-r5-{}-{nanos}", std::process::id()));
        let data = root.join("data");
        let dir = data.join(SHIP_DIR).join("planted");
        let agents = root.join("LaunchAgents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&agents).unwrap();
        let target = agents.join("com.agent.plist");
        std::fs::write(dir.join(PREVIOUS_APP), "<plist>agent job</plist>\n").unwrap();
        write_json(
            &dir.join(STATE),
            &json!({
                "id": "planted",
                "phase": "rolling-back",
                "to": { "sha": "0000000" },
                "from": { "sha": own },
                "appPath": target.to_string_lossy(),
                "dataDir": data.to_string_lossy(),
            }),
        )
        .unwrap();
        write_json(
            &data.join(SHIP_DIR).join(CURRENT),
            &json!({ "id": "planted" }),
        )
        .unwrap();
        let daily = Identity {
            kind: Kind::Daily,
            identifier: instance::DAILY_IDENTIFIER.into(),
            slot: None,
        };
        let _ = startup(&daily, &data);
        let moved = target.exists();
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            !moved,
            "startup moved a file from an unsigned ship record to the path that record chose, outside the sandbox"
        );
    }

    /// Not a finding: the hand-rolled HMAC matches RFC 4231 test cases 1, 2 and 6 (a key longer than the block).
    #[test]
    fn the_ship_mac_is_hmac_sha256_per_rfc_4231() {
        assert_eq!(
            hex_encode(&hmac_sha256(&[0x0b; 20], b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hex_encode(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex_encode(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }
}
