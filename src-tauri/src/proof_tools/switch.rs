//! PT-2: the per-project off switch for a proof tool (Settings > Crew > Proof tools).
//!
//! A person can turn a tool the project already has off for that project. An off tool never runs (not in the Full gate, not in
//! the ship check, not in a brief's "Proof tools here", not in the checker's replay) and is never proposed. The record sits beside
//! PT-1's proposal record in the Verify plugin's offer file (`verify-offers.json`): one file, one lock, one writer at a time.
//!
//! - **One door.** `run::detect_in` takes the project's switched-off tools out of what it returns, through `Env::switched_off`
//!   (`AppEnv` answers it from this record), so the gate, the ship check and the replay all read the switch in one place.
//! - **Compare-and-swap.** Each folder's record has its own `revision`: the store's revision right after that folder's last
//!   switch write. `set` writes only on top of the revision the caller read; a stale write is refused with `STALE` and nothing is
//!   changed. A proposal or a decline for another folder doesn't move it, so a window is only refused when this project's
//!   switches really changed. A folder keeps its record when its last tool is switched back on, so a revision can never come
//!   back round.
//! - **Untrusted file.** A file written before this has no switches and every tool reads as on; a hand-edited record is read
//!   entry by entry (`verify::lenient_off`). A record that can't be read at all reads as "nothing is off" for running and listing
//!   (as PT-1's proposal record does), and a write against it is refused, never guessed.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

use super::offers::tool_of;
use crate::plugins::registry::Host;
use crate::plugins::verify::{self, OffRecord};

/// The line a write based on an older revision gets. The webview shows it as it is, then reads the list again.
pub const STALE: &str = "That changed in another window. Look again, then set it.";

/// What a folder has switched off, and the revision the next write must be based on.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Switches {
    /// Tool ids, sorted.
    pub off: BTreeSet<String>,
    /// None yet is 0.
    pub revision: u64,
}

fn switches_of(record: Option<&OffRecord>) -> Switches {
    record.map_or_else(Switches::default, |record| Switches {
        off: record.tools.clone(),
        revision: record.revision,
    })
}

// ---- the folder a record is kept under ------------------------------------------------------------------------------------

/// The key a folder's record is kept under: its canonical path as text, the same words `offers` keys a proposal by. `None` for a
/// path that isn't a folder on this computer.
pub fn key_of_path(path: &Path) -> Option<String> {
    let root = crate::fs::canonical(path)
        .ok()
        .filter(|path| path.is_dir())?;
    Some(root.to_string_lossy().into_owned())
}

/// The key for a folder a person or a first mate named: the project's main checkout when the folder is a checkout of a project the
/// app knows (a worktree's switches are its project's), else the folder itself.
pub fn project_key(folder: &str) -> Result<String, String> {
    let root = verify::folder_key(folder)?;
    let main = crate::project_actions::checkout_of_project(&root)
        .ok()
        .map(|(main, _)| main);
    Ok(main
        .as_deref()
        .and_then(key_of_path)
        .unwrap_or_else(|| root.to_string_lossy().into_owned()))
}

// ---- reading it --------------------------------------------------------------------------------------------------------------

/// What `key` has switched off. A record that can't be read says nothing is off: every tool reads as on, and the next write
/// reports the real problem.
pub fn state(host: &Host, key: &str) -> Switches {
    verify::read_offers(host)
        .map(|offers| switches_of(offers.off.get(key)))
        .unwrap_or_default()
}

/// The ids the project whose main checkout is `main` has switched off: what a run, the ship check and a brief must leave out.
pub fn off_for_project(app: &tauri::AppHandle, main: &Path) -> BTreeSet<String> {
    let Some(key) = key_of_path(main) else {
        return BTreeSet::new();
    };
    match crate::plugins::host(app) {
        Ok(host) => state(&host, &key).off,
        Err(_) => BTreeSet::new(),
    }
}

// ---- writing it: under the lock, from a fresh read ---------------------------------------------------------------------------

/// Switch `tool_id` on (`on`) or off for `key`, on top of the revision the caller read (`expected`). A stale `expected` is refused
/// with `STALE` and nothing is written. Asking for what is already so (with the right revision) writes nothing and moves nothing.
/// Returns what the folder has switched off after the call.
pub fn set(
    host: &Host,
    key: &str,
    tool_id: &str,
    on: bool,
    expected: u64,
) -> Result<Switches, String> {
    tool_of(tool_id)?;
    let _lock = verify::exclusive(host)?;
    let mut offers = verify::read_offers(host)?;
    let current = switches_of(offers.off.get(key));
    if current.revision != expected {
        return Err(STALE.into());
    }
    // Off in the record means not `on`: already as asked when the two agree.
    if current.off.contains(tool_id) != on {
        return Ok(current);
    }
    offers.revision = offers.revision.saturating_add(1);
    let revision = offers.revision;
    let record = offers.off.entry(key.to_string()).or_default();
    if on {
        record.tools.remove(tool_id);
    } else {
        record.tools.insert(tool_id.to_string());
    }
    record.revision = revision;
    let next = switches_of(Some(record));
    verify::write_offers(host, &offers)?;
    Ok(next)
}

/// Switch one proof tool on or off for a project. `expected_revision` is the `revision` the list last said.
#[tauri::command(async)]
pub fn proof_tools_set(
    app: tauri::AppHandle,
    folder: String,
    tool_id: String,
    on: bool,
    expected_revision: u64,
) -> Result<Switches, String> {
    let key = project_key(&folder)?;
    set(
        &crate::plugins::host(&app)?,
        &key,
        &tool_id,
        on,
        expected_revision,
    )
}

#[cfg(test)]
pub(crate) mod test_env {
    use std::collections::BTreeSet;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use crate::firstmate::brief_checks::{Ended, RawRun};
    use crate::proof_tools::command::Prepared;
    use crate::proof_tools::run::Env;

    /// A runner that answers every command with a pass and says which tools are switched off. It records the id of each command
    /// it was asked to run, so a test can see that an off tool was never started.
    pub struct OffEnv {
        pub off: BTreeSet<String>,
        pub scratch: PathBuf,
        pub ran: Mutex<Vec<String>>,
    }

    impl OffEnv {
        pub fn new(off: &[&str], scratch: PathBuf) -> OffEnv {
            OffEnv {
                off: off.iter().map(|id| id.to_string()).collect(),
                scratch,
                ran: Mutex::new(Vec::new()),
            }
        }
        pub fn ran(&self) -> Vec<String> {
            self.ran.lock().unwrap().clone()
        }
    }

    impl Env for OffEnv {
        fn probe(&self, _argv: &[String]) -> bool {
            false
        }
        fn run(&self, id: &str, _name: &str, _prepared: &Prepared, _timeout: u64) -> RawRun {
            self.ran.lock().unwrap().push(id.to_string());
            RawRun {
                ended: Ended::Exited(Some(0)),
                output: "Running 2 tests using 1 worker\n  2 passed (1.2s)\n".into(),
                seconds: 0.1,
            }
        }
        fn scratch(&self) -> Option<PathBuf> {
            Some(self.scratch.clone())
        }
        fn switched_off(&self) -> BTreeSet<String> {
            self.off.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};

    use serde_json::{json, Value};

    use super::*;
    use crate::proof_tools::offers;

    struct Tmp(PathBuf);

    impl Tmp {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("hivra pt2 {label} plüg {}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Tmp(crate::fs::canonical(&dir).unwrap())
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn project(&self, name: &str) -> String {
            let dir = self.0.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            dir.display().to_string()
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn host(tmp: &Tmp) -> Host {
        let host = Host {
            root: tmp.path().join("app data/plugins"),
            agents_skills: tmp.path().join("home/.agents/skills"),
        };
        std::fs::create_dir_all(&host.root).unwrap();
        host
    }

    fn file(host: &Host) -> PathBuf {
        host.root.join("verify-offers.json")
    }

    fn saved(host: &Host) -> Value {
        serde_json::from_str(&std::fs::read_to_string(file(host)).unwrap()).unwrap()
    }

    fn key(folder: &str) -> String {
        project_key(folder).unwrap()
    }

    #[test]
    fn a_switch_round_trips_off_and_back_on_and_the_revision_only_grows() {
        let tmp = Tmp::new("round");
        let host = host(&tmp);
        let folder = key(&tmp.project("proj one"));
        assert_eq!(state(&host, &folder), Switches::default());

        let off = set(&host, &folder, "stryker", false, 0).unwrap();
        assert_eq!(off.off.iter().collect::<Vec<_>>(), ["stryker"]);
        assert_eq!(off.revision, 1);
        assert_eq!(state(&host, &folder), off);

        let more = set(&host, &folder, "playwright", false, 1).unwrap();
        assert_eq!(
            more.off.iter().collect::<Vec<_>>(),
            ["playwright", "stryker"]
        );
        assert_eq!(more.revision, 2);

        let back = set(&host, &folder, "stryker", true, 2).unwrap();
        assert_eq!(back.off.iter().collect::<Vec<_>>(), ["playwright"]);
        assert_eq!(back.revision, 3);
        let clear = set(&host, &folder, "playwright", true, 3).unwrap();
        assert!(clear.off.is_empty());
        assert_eq!(clear.revision, 4);
        // The folder keeps its record with no tool in it, so revision 0 or 1 can never be taken for the current one.
        assert_eq!(
            saved(&host)["off"][folder.as_str()],
            json!({ "tools": [], "revision": 4 })
        );
        assert_eq!(set(&host, &folder, "stryker", false, 0).unwrap_err(), STALE);
    }

    #[test]
    fn a_stale_write_is_refused_with_the_plain_line_and_changes_nothing() {
        let tmp = Tmp::new("stale");
        let host = host(&tmp);
        let folder = key(&tmp.project("proj"));
        // Another window switched Stryker off after this one read revision 0.
        set(&host, &folder, "stryker", false, 0).unwrap();
        let before = std::fs::read_to_string(file(&host)).unwrap();
        let error = set(&host, &folder, "playwright", false, 0).unwrap_err();
        assert_eq!(
            error,
            "That changed in another window. Look again, then set it."
        );
        assert_eq!(
            std::fs::read_to_string(file(&host)).unwrap(),
            before,
            "a refused write leaves the file as it was"
        );
        assert_eq!(
            state(&host, &folder).off.iter().collect::<Vec<_>>(),
            ["stryker"]
        );
        // A revision from the future is as stale as one from the past: only the revision just read is accepted.
        assert_eq!(
            set(&host, &folder, "playwright", false, 99).unwrap_err(),
            STALE
        );
        // Asking for what is already so on a stale revision is refused too: the window must look again first.
        assert_eq!(set(&host, &folder, "stryker", false, 0).unwrap_err(), STALE);
        // From the revision the refusal's re-read gives, the write goes through.
        assert!(set(&host, &folder, "playwright", false, 1).is_ok());
    }

    #[test]
    fn asking_for_what_is_already_so_writes_nothing() {
        let tmp = Tmp::new("noop");
        let host = host(&tmp);
        let folder = key(&tmp.project("proj"));
        let same = set(&host, &folder, "stryker", true, 0).unwrap();
        assert_eq!(same, Switches::default());
        assert!(
            !file(&host).exists(),
            "switching on what is on writes no file"
        );
        set(&host, &folder, "stryker", false, 0).unwrap();
        let before = std::fs::read_to_string(file(&host)).unwrap();
        let again = set(&host, &folder, "stryker", false, 1).unwrap();
        assert_eq!(again.revision, 1, "no new revision for no change");
        assert_eq!(std::fs::read_to_string(file(&host)).unwrap(), before);
    }

    #[test]
    fn each_project_has_its_own_switches_and_revision_and_a_proposal_elsewhere_does_not_make_a_write_stale(
    ) {
        let tmp = Tmp::new("folders");
        let host = host(&tmp);
        let one = key(&tmp.project("one"));
        let two = key(&tmp.project("two"));
        set(&host, &one, "stryker", false, 0).unwrap();
        assert_eq!(state(&host, &two), Switches::default());
        // A proposal for a tool in project two moves the store's revision, not project one's.
        assert!(matches!(
            offers::claim(&host, &tmp.project("two"), "fast-check").unwrap(),
            offers::Claim::Claimed { .. }
        ));
        let next = set(&host, &one, "playwright", false, 1).unwrap();
        assert_eq!(
            next.off.iter().collect::<Vec<_>>(),
            ["playwright", "stryker"]
        );
        // Project two is untouched, and the proposal record is still there beside the switches.
        assert_eq!(state(&host, &two), Switches::default());
        let record = saved(&host);
        assert_eq!(
            record["tools"][two.as_str()]["fast-check"]["state"],
            "proposed"
        );
        assert_eq!(record["off"][one.as_str()]["revision"], next.revision);
    }

    #[test]
    fn a_switch_write_keeps_what_else_the_file_holds() {
        let tmp = Tmp::new("keeps");
        let host = host(&tmp);
        let folder = key(&tmp.project("proj"));
        std::fs::write(
            file(&host),
            json!({
                "revision": 5,
                "declined": [folder],
                "tools": { folder.as_str(): { "stryker": { "state": "declined", "claimedAt": 3 } } }
            })
            .to_string(),
        )
        .unwrap();
        let next = set(&host, &folder, "playwright", false, 0).unwrap();
        assert_eq!(next.revision, 6, "the store's own revision moves on");
        let record = saved(&host);
        assert_eq!(record["declined"], json!([folder]));
        assert_eq!(
            record["tools"][folder.as_str()]["stryker"]["state"],
            "declined"
        );
        assert_eq!(
            record["off"][folder.as_str()]["tools"],
            json!(["playwright"])
        );
    }

    #[test]
    fn a_file_written_before_switches_existed_reads_every_tool_as_on() {
        let tmp = Tmp::new("old");
        let host = host(&tmp);
        let folder = key(&tmp.project("proj"));
        // PT-1's file (no `off`), and the Verify plugin's older one (no `tools` either).
        for old in [
            json!({ "revision": 2, "declined": [], "tools": {} }),
            json!({ "revision": 1, "declined": [folder] }),
        ] {
            std::fs::write(file(&host), old.to_string()).unwrap();
            assert_eq!(state(&host, &folder), Switches::default());
            let next = set(&host, &folder, "stryker", false, 0).unwrap();
            assert_eq!(next.revision, old["revision"].as_u64().unwrap() + 1);
        }
        // Nothing is written until someone switches: reading a file doesn't add the record.
        std::fs::write(file(&host), json!({ "revision": 2 }).to_string()).unwrap();
        let _ = state(&host, &folder);
        assert!(saved(&host).get("off").is_none());
    }

    #[test]
    fn a_hand_edited_record_is_read_entry_by_entry_and_never_breaks_the_file() {
        let tmp = Tmp::new("edited");
        let host = host(&tmp);
        let folder = key(&tmp.project("proj"));
        let other = key(&tmp.project("other"));
        std::fs::write(
            file(&host),
            json!({
                "revision": 4,
                "declined": [],
                "off": {
                    folder.as_str(): { "tools": ["stryker", 7, null, "playwright"], "revision": 3 },
                    other.as_str(): "everything",
                    "/nowhere": { "tools": "stryker", "revision": -1 }
                }
            })
            .to_string(),
        )
        .unwrap();
        let read = state(&host, &folder);
        assert_eq!(
            read.off.iter().collect::<Vec<_>>(),
            ["playwright", "stryker"],
            "a tool id that isn't text is dropped, the rest stand"
        );
        assert_eq!(read.revision, 3);
        assert_eq!(
            state(&host, &other),
            Switches::default(),
            "an entry that isn't a record is left out"
        );
        assert_eq!(state(&host, "/nowhere"), Switches::default());
        // The whole `off` being the wrong shape reads as none; the offer list itself is still readable.
        std::fs::write(
            file(&host),
            json!({ "revision": 4, "declined": [folder], "off": ["stryker"] }).to_string(),
        )
        .unwrap();
        assert_eq!(state(&host, &folder), Switches::default());
        assert!(verify::read_offers(&host)
            .unwrap()
            .declined
            .contains(&folder));
    }

    #[test]
    fn a_record_that_cannot_be_read_says_nothing_is_off_and_refuses_a_write() {
        let tmp = Tmp::new("broken");
        let host = host(&tmp);
        let folder = key(&tmp.project("proj"));
        std::fs::write(file(&host), "{ this is not json").unwrap();
        assert_eq!(state(&host, &folder), Switches::default());
        let error = set(&host, &folder, "stryker", false, 0).unwrap_err();
        assert!(error.contains("can't be read"), "{error}");
        assert_eq!(
            std::fs::read_to_string(file(&host)).unwrap(),
            "{ this is not json",
            "a file that can't be read is never overwritten"
        );
    }

    #[test]
    fn only_a_tool_in_the_catalogue_can_be_switched() {
        let tmp = Tmp::new("unknown");
        let host = host(&tmp);
        let folder = key(&tmp.project("proj"));
        for id in ["", "not-a-tool", "../stryker", "stryker ", "STRYKER"] {
            let error = set(&host, &folder, id, false, 0).unwrap_err();
            assert_eq!(error, "That isn't a proof tool I know.", "{id:?}");
        }
        assert!(!file(&host).exists());
    }

    #[test]
    fn of_many_windows_writing_on_the_same_revision_exactly_one_wins() {
        let tmp = Tmp::new("race");
        let host = Arc::new(host(&tmp));
        let folder = Arc::new(key(&tmp.project("proj")));
        const IDS: [&str; 6] = [
            "stryker",
            "playwright",
            "fast-check",
            "semgrep",
            "e2e",
            "proptest",
        ];
        let gate = Arc::new(Barrier::new(IDS.len()));
        let handles: Vec<_> = IDS
            .into_iter()
            .map(|id| {
                let (host, folder, gate) = (host.clone(), folder.clone(), gate.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    set(&host, &folder, id, false, 0)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let won = results.iter().filter(|result| result.is_ok()).count();
        let refused: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).collect();
        // The lock makes each write a fresh read: the first lands, and every other one based on revision 0 is refused. A caller
        // that can't get the lock in time is told to try again, which is not a write either.
        assert_eq!(won, 1, "{results:?}");
        assert!(
            refused
                .iter()
                .all(|error| error.as_str() == STALE || error.contains("Try again")),
            "{refused:?}"
        );
        assert_eq!(state(&host, &folder).off.len(), 1);
    }

    #[test]
    fn a_folder_is_keyed_by_its_canonical_path_whatever_way_it_is_named() {
        let tmp = Tmp::new("keys");
        let host = host(&tmp);
        let plain = tmp.project("proj one");
        let roundabout = format!("{plain}/../proj one/.");
        assert_eq!(key(&plain), key(&roundabout));
        assert_eq!(
            key_of_path(Path::new(&plain)).as_deref(),
            Some(key(&plain).as_str())
        );
        // The proposal record keys a folder the same way, so one folder is one folder in both.
        assert_eq!(
            key(&plain),
            verify::folder_key(&plain).unwrap().to_string_lossy()
        );
        set(&host, &key(&plain), "stryker", false, 0).unwrap();
        assert_eq!(state(&host, &key(&roundabout)).off.len(), 1);
        // A folder that isn't there is not a key.
        assert!(project_key(&format!("{plain}/missing")).is_err());
        assert!(project_key("   ").is_err());
        assert_eq!(key_of_path(&tmp.path().join("missing")), None);
    }
}
