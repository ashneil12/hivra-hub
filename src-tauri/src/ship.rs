//! Ship: install a verified worktree build into the daily app, safely, even from a chat inside the app being replaced
//! (Phase 1b, WP3: `docs/PHASE-1B-DEV-SETUP.md`, "Ship").
//!
//! The whole path:
//! 1. `scripts/hub-ship.mjs` (`npm run hub:ship`, the `app.ship` action, later a button) checks the build, copies it
//!    to `<data>/ship/<id>/staged/`, writes `state.json` ("staged") and starts `runner.mjs` (a copy of
//!    `scripts/hub-ship-runner.mjs`) as a one-shot LaunchAgent, outside this app's process group.
//! 2. This app's watcher ([`init`]) sees the staged build and accepts it only if its signature matches the app's own
//!    (`accepted.json`, or `refused.json` with why). It then quits for the update once no other turn is running, or
//!    straight away on "Restart now" (`window::request_update_quit`): the normal quit path without the dialog, cut
//!    turns saved for resume and marked with the ship's id.
//! 3. The runner waits for this process to exit, backs up the database files and `monos/`, renames the old app to
//!    `previous.app.off`, moves the staged build into place ("trial") and opens it.
//! 4. The new build ([`startup`] returns [`Boot::Trial`]) holds auto-resume, habits and automations ([`holding`]) until
//!    its window, database and hub bridge are up ([`ship_ready`]), then writes `committed.json`.
//! 5. No commit in time, or an early exit, and the runner rolls back: the old app and the database copy go back.
//! 6. `receipt.json` and `runner.log` say what happened; Today shows it and the shipping Lead's resume note carries it.
//!
//! **When the runner dies** (a crash, a reboot), [`startup`] finishes what it left before the database opens: a trial
//! (this build holds and the runner is restarted to watch it), a restore (the old app and database go back), or a
//! ship that never got as far as the swap (called off). [`plan`] is that decision, as a pure function.
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
const BRIDGE_WAIT: Duration = Duration::from_secs(60);

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
        Swapping if !facts.old_moved => Plan::Cancel(
            "The swap was interrupted before anything moved, so nothing changed. Ship again."
                .into(),
        ),
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
    let Some(phase) = ship.phase() else {
        return Boot::Normal;
    };
    let me = me_for(&instance::stamp().sha, ship.new_sha(), ship.old_sha());
    let facts = Facts {
        phase,
        old_moved: ship.step("oldMoved"),
        new_moved: ship.step("newMoved"),
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
                    let _ = ship.save();
                    write_receipt(&ship, "app");
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
/// checksum taken at backup time, and swap `monos/` back.
pub fn restore_db(ship: &Ship) -> Result<Value, String> {
    let backup = ship.dir.join(BACKUP_DIR);
    let data = ship.data_dir();
    let expected = ship.doc.pointer("/db/backup").cloned().unwrap_or(json!({}));
    let mut restored = Map::new();
    for name in DB_FILES {
        let from = backup.join(name);
        let to = data.join(name);
        if from.is_file() {
            let temporary = data.join(format!(".{name}.restoring"));
            std::fs::copy(&from, &temporary)
                .map_err(|error| format!("Couldn't copy {name} back: {error}"))?;
            std::fs::rename(&temporary, &to).map_err(|e| e.to_string())?;
            let sum = sha256_file(&to)?;
            if let Some(want) = expected.get(name).and_then(Value::as_str) {
                if want != sum {
                    return Err(format!(
                        "{name} doesn't match its backup after the copy ({sum} vs {want})"
                    ));
                }
            }
            restored.insert(name.into(), json!(sum));
        } else if to.exists() {
            std::fs::remove_file(&to).map_err(|e| e.to_string())?;
        }
    }
    let saved = backup.join(MONOS);
    let live = data.join(MONOS);
    let staging = data.join(".monos.restoring");
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    if saved.is_dir() {
        copy_dir(&saved, &staging)?;
    }
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

/// The runner keeps going under launchd (or as a plain detached process when the ship said so).
fn restart_runner(ship: &Ship) {
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
        let mut command = Command::new(app.join("Contents/MacOS/monocode"));
        if let Some(env) = ship.doc.pointer("/launch/env").and_then(Value::as_object) {
            for (key, value) in env {
                if let Some(value) = value.as_str() {
                    command.env(key, value);
                }
            }
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.spawn().map(|_| ())
    } else {
        // -n: this process (the build being put aside) still runs under the same identifier, and a plain open would
        // only bring it to the front.
        Command::new("/usr/bin/open")
            .arg("-n")
            .arg(&app)
            .status()
            .map(|_| ())
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

/// The window calls this once it has drawn the workspace. The database and the hub bridge are checked off the main
/// thread; when all three are up, the build commits.
#[tauri::command]
pub fn ship_ready(app: AppHandle) -> Value {
    let start = {
        let mut trial = TRIAL.lock().unwrap_or_else(|poison| poison.into_inner());
        match trial.as_mut() {
            Some(trial) if !trial.committed && !trial.checking => {
                trial.checking = true;
                Some((trial.id.clone(), trial.dir.clone()))
            }
            _ => None,
        }
    };
    if let Some((id, dir)) = start {
        let app = app.clone();
        std::thread::spawn(move || run_trial_checks(&app, &id, &dir));
    }
    status()
}

fn run_trial_checks(app: &AppHandle, id: &str, dir: &Path) {
    let db = check_database(app);
    let bridge = check_bridge(dir);
    let checks = json!({
        "window": true,
        "database": match &db { Ok(sessions) => json!({"ok": true, "sessions": sessions}), Err(e) => json!({"ok": false, "error": e}) },
        "bridge": match &bridge { Ok(said) => json!({"ok": true, "said": said}), Err(e) => json!({"ok": false, "error": e}) },
    });
    if db.is_err() || bridge.is_err() {
        log(dir, &format!("trial checks failed: {checks}"));
        let _ = write_json(&dir.join(TRIAL_CHECKS), &checks);
        if let Ok(mut trial) = TRIAL.lock() {
            if let Some(trial) = trial.as_mut() {
                trial.checking = false;
            }
        }
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
    if let Err(error) = write_json(&dir.join(COMMITTED), &note) {
        log(dir, &format!("couldn't write {COMMITTED}: {error}"));
        return;
    }
    if let Ok(mut trial) = TRIAL.lock() {
        if let Some(trial) = trial.as_mut() {
            trial.committed = true;
            trial.checking = false;
        }
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

/// The bridge must be up if it was up before the update (the old app wrote that down when it accepted the build). If
/// it was already down, a down bridge isn't this build's fault.
fn check_bridge(dir: &Path) -> Result<String, String> {
    let before = read_json(&dir.join(ACCEPTED)).and_then(|accepted| {
        accepted
            .get("bridge")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let required = before.as_deref() == Some("up");
    let deadline = Instant::now()
        + if required {
            BRIDGE_WAIT
        } else {
            Duration::ZERO
        };
    loop {
        match crate::hub::probe() {
            Ok(()) => return Ok("up".into()),
            Err(error) if !required => {
                return Ok(format!(
                    "not required (before the update: {}): {}",
                    before.as_deref().unwrap_or("unknown"),
                    error.message
                ))
            }
            Err(error) if Instant::now() >= deadline => {
                return Err(format!(
                    "The hub bridge was up before the update and isn't now: {}",
                    error.message
                ))
            }
            Err(_) => std::thread::sleep(Duration::from_secs(2)),
        }
    }
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
                let bridge = if crate::hub::probe().is_ok() {
                    "up"
                } else {
                    "down"
                };
                let stamp = instance::stamp();
                let note = json!({
                    "pid": std::process::id(),
                    "sha": stamp.sha,
                    "at": now_iso(),
                    "bridge": bridge,
                });
                if write_json(&accepted, &note).is_err() {
                    return;
                }
                log(
                    &ship.dir,
                    &format!("accepted the staged build (bridge {bridge})"),
                );
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

/// `app.ship`: run `scripts/hub-ship.mjs` from the asking session's checkout, on its behalf. It checks, stages and
/// schedules, and returns within seconds; this app then quits for the update when it's quiet, and that session's turn
/// resumes with the receipt.
#[tauri::command(async)]
pub fn ship_start(
    repo: String,
    requested_by: Option<String>,
    when_busy: Option<String>,
) -> Result<Value, String> {
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
    let output = command.output().map_err(|e| e.to_string())?;
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
        std::fs::create_dir_all(backup.join("monos/frank")).unwrap();
        std::fs::write(backup.join("monocode.db"), b"old database").unwrap();
        std::fs::write(backup.join("monocode.db-wal"), b"old wal").unwrap();
        std::fs::write(backup.join("monos/frank/SOUL.md"), b"old soul").unwrap();
        // What the new build did to the live data during its trial.
        std::fs::create_dir_all(data.join("monos/frank")).unwrap();
        std::fs::write(data.join("monocode.db"), b"migrated by the new build").unwrap();
        std::fs::write(data.join("monocode.db-shm"), b"new shm").unwrap();
        std::fs::write(data.join("monos/frank/SOUL.md"), b"new soul").unwrap();
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
            std::fs::read(data.join("monos/frank/SOUL.md")).unwrap(),
            b"old soul"
        );
        assert_eq!(
            std::fs::read(ship.dir.join(REJECTED_MONOS).join("frank/SOUL.md")).unwrap(),
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
        std::fs::write(ship.dir.join(BACKUP_DIR).join("monocode.db"), b"changed").unwrap();
        let error = restore(&mut ship, Me::New).unwrap_err();
        assert!(error.contains("doesn't match its backup"), "{error}");
        assert!(!Ship::load(&ship.dir).unwrap().step("dbRestored"));
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

    #[test]
    fn the_runner_lock_is_one_holder_at_a_time() {
        let dir = TempDir::new("runner-lock");
        let held = InstanceLock::acquire_file(&dir.0.join(RUNNER_LOCK), Duration::ZERO).unwrap();
        assert!(InstanceLock::acquire_file(&dir.0.join(RUNNER_LOCK), Duration::ZERO).is_err());
        drop(held);
        assert!(InstanceLock::acquire_file(&dir.0.join(RUNNER_LOCK), Duration::ZERO).is_ok());
    }
}
