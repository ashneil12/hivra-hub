//! PT-1: the per-project record of proof-tool proposals. A first mate may propose a tool that fits a project and isn't there,
//! once per project per tool. The record lives in the Verify plugin's offer file (`verify-offers.json`, its lock and its
//! `revision`, `plugins/verify.rs`) rather than in a store of its own: one file, one writer at a time, and a writer that read an
//! older revision loses. A file written before this existed has no `tools` and reads as it always did.
//!
//! - **Claim.** `claim` moves a tool from open to proposed under the lock, once. A second claim (another window, another first
//!   mate, a retry) gets `Already(Proposed)`; a declined tool stays declined. The claim is what makes a proposal "once": it
//!   is recorded before the person is asked, and `release` undoes exactly that claim when the ask could not be filed (a
//!   timeout or an unreachable decision store is not a final failure, so the first mate may propose again).
//! - **Not now.** The proposal is one Needs-you decision, `proof-tools/<tool id>/<folder tag>`. When the person answers
//!   "Not now" (`decisions_answer` calls `on_answered`), the tool is declined for that folder and is never proposed again.
//!   The tag is a hash of the folder, because the decision's own `project` may be a hub project id rather than a folder.
//! - The Verify plugin's own "not now" counts for `e2e`: the person already said no to it for that folder.
//!
//! Nothing here installs anything. `install` is shown to the person's first mate so it can brief a worker, and only after the
//! person answers "Add it".

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::catalogue::{self, Tool, ANSWER_ADD, ANSWER_NOT_NOW, DECISION_PREFIX};
use super::detect;
use crate::plugins::registry::Host;
use crate::plugins::verify::{self, Offers, ToolOffer, ToolState};

const UNKNOWN_TOOL: &str = "That isn't a proof tool I know.";
/// The tool the Verify plugin offers; a "not now" to that offer is a "not now" here.
const VERIFY_TOOL: &str = "e2e";

/// Where one tool stands for one folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Never proposed. A first mate may propose it.
    Open,
    /// Put to the person. It is not proposed again, whatever the answer.
    Proposed,
    /// The person said not now. Never proposed again.
    Declined,
}

/// What `claim` found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claim {
    /// This call recorded the proposal. `revision` is the store's revision right after, which `release` must name.
    Claimed { revision: u64 },
    /// Not this call's to propose: it already was, or the person said not now.
    Already(Status),
}

// ---- the folder and its decision key -------------------------------------------------------------------------------------

/// FNV-1a, 64 bit. A stable tag, not a secret: it only names a folder inside a decision key.
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Twelve lower-case hex characters naming a folder (its canonical display string).
pub fn folder_tag(display: &str) -> String {
    let mut tag = format!("{:016x}", fnv1a(display));
    tag.truncate(12);
    tag
}

/// The decision key one proposal is filed under: stable per tool and folder, so asking twice never asks twice, and made only of
/// letters, digits, `-` and `/` (the decision gate's key rules, 120 characters at most).
pub fn decision_key(tool: &Tool, folder_display: &str) -> String {
    format!(
        "{DECISION_PREFIX}{}/{}",
        tool.id,
        folder_tag(folder_display)
    )
}

fn folder_display(folder: &str) -> Result<String, String> {
    Ok(verify::folder_key(folder)?.to_string_lossy().into_owned())
}

fn tool_of(tool_id: &str) -> Result<&'static Tool, String> {
    catalogue::find(tool_id).ok_or_else(|| UNKNOWN_TOOL.to_string())
}

/// The tool id and folder tag a proposal's decision key names, or none for any other key.
fn parse_key(key: &str) -> Option<(&'static Tool, &str)> {
    let rest = key.trim().strip_prefix(DECISION_PREFIX)?;
    let (id, tag) = rest.split_once('/')?;
    if tag.len() != 12 || !tag.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    Some((catalogue::find(id)?, tag))
}

// ---- reading the record --------------------------------------------------------------------------------------------------

fn status_in(offers: &Offers, folder: &str, tool_id: &str) -> Status {
    let stored = offers
        .tools
        .get(folder)
        .and_then(|tools| tools.get(tool_id))
        .map(|offer| offer.state);
    // The Verify plugin's own "not now" for this folder is a "not now" to e2e, whatever else is on record.
    if tool_id == VERIFY_TOOL && offers.declined.contains(folder) {
        return Status::Declined;
    }
    match stored {
        Some(ToolState::Declined) => Status::Declined,
        Some(ToolState::Proposed) => Status::Proposed,
        None => Status::Open,
    }
}

/// Where `tool_id` stands for `folder`. (The Settings list, PT-2, reads this one tool at a time.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn status(host: &Host, folder: &str, tool_id: &str) -> Result<Status, String> {
    tool_of(tool_id)?;
    let key = folder_display(folder)?;
    Ok(status_in(&verify::read_offers(host)?, &key, tool_id))
}

/// Where every catalogue tool stands for `folder`, by tool id.
pub fn statuses(host: &Host, folder: &str) -> Result<BTreeMap<String, Status>, String> {
    let key = folder_display(folder)?;
    let offers = verify::read_offers(host)?;
    Ok(catalogue::tools()
        .iter()
        .map(|tool| (tool.id.clone(), status_in(&offers, &key, &tool.id)))
        .collect())
}

// ---- writing it: always under the lock, always from a fresh read ---------------------------------------------------------

/// Record that `tool_id` was proposed for `folder`, once. Compare-and-set under the offer file's lock: of any number of
/// concurrent callers exactly one gets `Claimed`.
pub fn claim(host: &Host, folder: &str, tool_id: &str) -> Result<Claim, String> {
    tool_of(tool_id)?;
    let key = folder_display(folder)?;
    let _lock = verify::exclusive(host)?;
    let mut offers = verify::read_offers(host)?;
    match status_in(&offers, &key, tool_id) {
        Status::Open => {}
        other => return Ok(Claim::Already(other)),
    }
    offers.revision = offers.revision.saturating_add(1);
    offers.tools.entry(key).or_default().insert(
        tool_id.to_string(),
        ToolOffer {
            state: ToolState::Proposed,
            claimed_at: offers.revision,
        },
    );
    verify::write_offers(host, &offers)?;
    Ok(Claim::Claimed {
        revision: offers.revision,
    })
}

/// Undo the claim that returned `revision`, because the person could not be asked. Only that claim: a tool that is no longer
/// proposed, was declined, or was claimed again since (a different revision) is left as it is and this returns `false`.
pub fn release(host: &Host, folder: &str, tool_id: &str, revision: u64) -> Result<bool, String> {
    tool_of(tool_id)?;
    let key = folder_display(folder)?;
    let _lock = verify::exclusive(host)?;
    let mut offers = verify::read_offers(host)?;
    let holds = offers
        .tools
        .get(&key)
        .and_then(|tools| tools.get(tool_id))
        .is_some_and(|offer| offer.state == ToolState::Proposed && offer.claimed_at == revision);
    if !holds {
        return Ok(false);
    }
    if let Some(tools) = offers.tools.get_mut(&key) {
        tools.remove(tool_id);
        if tools.is_empty() {
            offers.tools.remove(&key);
        }
    }
    offers.revision = offers.revision.saturating_add(1);
    verify::write_offers(host, &offers)?;
    Ok(true)
}

/// The person said not now: never propose `tool_id` for `folder` again. Idempotent. `true` when this call changed the record,
/// `false` when it was already declined. A tool that was never proposed can be declined too (the Settings list, PT-2).
#[cfg_attr(not(test), allow(dead_code))]
pub fn decline(host: &Host, folder: &str, tool_id: &str) -> Result<bool, String> {
    tool_of(tool_id)?;
    let key = folder_display(folder)?;
    let _lock = verify::exclusive(host)?;
    let mut offers = verify::read_offers(host)?;
    Ok(decline_in(&mut offers, &key, tool_id) && write_bumped(host, &mut offers)?)
}

/// Set one tool declined in one folder. `false` when it already was, so nothing needs writing.
fn decline_in(offers: &mut Offers, key: &str, tool_id: &str) -> bool {
    let tools = offers.tools.entry(key.to_string()).or_default();
    match tools.get(tool_id) {
        Some(offer) if offer.state == ToolState::Declined => false,
        other => {
            let claimed_at = other.map_or(0, |offer| offer.claimed_at);
            tools.insert(
                tool_id.to_string(),
                ToolOffer {
                    state: ToolState::Declined,
                    claimed_at,
                },
            );
            true
        }
    }
}

fn write_bumped(host: &Host, offers: &mut Offers) -> Result<bool, String> {
    offers.revision = offers.revision.saturating_add(1);
    verify::write_offers(host, offers)?;
    Ok(true)
}

// ---- the person's answer -------------------------------------------------------------------------------------------------

/// A decision key and its answer, read from the store. `true` when it was a proof-tool proposal answered "Not now" and a folder
/// was declined for it. Any other key, and any other answer, changes nothing. Never errors outward: a record that can't be
/// written leaves the tool proposed, which is never proposed again either way.
pub(crate) fn on_answer_in(host: &Host, key: &str, answer: &str) -> bool {
    let Some((tool, tag)) = parse_key(key) else {
        return false;
    };
    if !answer.trim().eq_ignore_ascii_case(ANSWER_NOT_NOW) {
        return false;
    }
    let Ok(_lock) = verify::exclusive(host) else {
        return false;
    };
    let Ok(mut offers) = verify::read_offers(host) else {
        return false;
    };
    let folders: Vec<String> = offers
        .tools
        .iter()
        .filter(|(folder, tools)| tools.contains_key(&tool.id) && folder_tag(folder) == tag)
        .map(|(folder, _)| folder.clone())
        .collect();
    let mut changed = false;
    for folder in folders {
        changed |= decline_in(&mut offers, &folder, &tool.id);
    }
    changed && write_bumped(host, &mut offers).unwrap_or(false)
}

/// `decisions_answer` calls this after an answer was applied. A "Not now" to a proof-tool proposal is remembered for that
/// project.
pub fn on_answered(app: &tauri::AppHandle, decision: &crate::decisions::Decision) {
    if decision.state != crate::decisions::ANSWERED {
        return;
    }
    let Some(answer) = decision.answer.as_deref() else {
        return;
    };
    if let Ok(host) = crate::plugins::host(app) {
        let _ = on_answer_in(&host, &decision.decision_key, answer);
    }
}

// ---- proposing -----------------------------------------------------------------------------------------------------------

/// The tool as a first mate may read it: what it is, what it proves, and the command a worker would run if the person says yes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    pub id: String,
    pub name: String,
    pub proves: String,
    pub install: String,
    pub pinned: String,
    pub licence: String,
    pub repo: String,
    pub external: bool,
}

impl ToolView {
    fn of(tool: &Tool) -> ToolView {
        ToolView {
            id: tool.id.clone(),
            name: tool.name.clone(),
            proves: tool.proves.clone(),
            install: tool.install.clone(),
            pinned: tool.pinned.clone(),
            licence: tool.licence.clone(),
            repo: tool.repo.clone(),
            external: tool.external,
        }
    }
}

/// What a proposal may do, and the decision to file when it may.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimView {
    /// This call recorded the proposal: the caller files `key` / `question` / `options` / `recommended` now.
    pub claimed: bool,
    pub status: Status,
    /// The store's revision: the claim's when `claimed`, else the current one. `release` names it.
    pub revision: u64,
    pub key: String,
    pub question: String,
    pub options: Vec<String>,
    pub recommended: String,
    pub tool: ToolView,
    /// One plain sentence on what happened and what to do.
    pub note: String,
}

fn view(
    tool: &Tool,
    folder: &str,
    claimed: bool,
    status: Status,
    revision: u64,
    note: impl Into<String>,
) -> ClaimView {
    ClaimView {
        claimed,
        status,
        revision,
        key: decision_key(tool, folder),
        question: tool.question(),
        options: vec![ANSWER_ADD.to_string(), ANSWER_NOT_NOW.to_string()],
        recommended: ANSWER_ADD.to_string(),
        tool: ToolView::of(tool),
        note: note.into(),
    }
}

fn already_note(status: Status) -> &'static str {
    match status {
        Status::Declined => "The person said not now for this project. Don't propose it again.",
        _ => "Already proposed to the person for this project; it won't be proposed again.",
    }
}

/// Whether `tool_id` may be proposed for `folder` now, and if so record that it was. The tool must fit the project (its stack
/// is there) and not already be there, by the file rules alone: nothing is run to find out. Nothing is installed.
pub fn propose_claim_in(host: &Host, folder: &str, tool_id: &str) -> Result<ClaimView, String> {
    let tool = tool_of(tool_id)?;
    let root = verify::folder_key(folder)?;
    let display = root.to_string_lossy().into_owned();
    let offers = verify::read_offers(host)?;
    let stored = status_in(&offers, &display, tool_id);
    let detection = detect::detect(&root, &detect::NoProbe);
    match detection
        .fitting
        .iter()
        .find(|found| found.tool.id == tool.id)
    {
        None => {
            return Ok(view(
                tool,
                &display,
                false,
                stored,
                offers.revision,
                format!(
                    "{} doesn't fit this project, so it isn't proposed.",
                    tool.name
                ),
            ));
        }
        Some(found) if found.installed => {
            return Ok(view(
                tool,
                &display,
                false,
                stored,
                offers.revision,
                format!("This project already has {}.", tool.name),
            ));
        }
        Some(_) => {}
    }
    match claim(host, folder, tool_id)? {
        Claim::Claimed { revision } => Ok(view(
            tool,
            &display,
            true,
            Status::Proposed,
            revision,
            "Not proposed before for this project. File the question now.",
        )),
        Claim::Already(status) => {
            let revision = verify::read_offers(host)?.revision;
            Ok(view(
                tool,
                &display,
                false,
                status,
                revision,
                already_note(status),
            ))
        }
    }
}

/// A first mate's proposal: records it (once) and hands back the decision to file. The webview files it through the existing
/// ask path, and calls `proof_tools_propose_release` if that fails.
#[tauri::command(async)]
pub fn proof_tools_propose_claim(
    app: tauri::AppHandle,
    folder: String,
    tool_id: String,
) -> Result<ClaimView, String> {
    propose_claim_in(&crate::plugins::host(&app)?, &folder, &tool_id)
}

/// Undo a claim whose question could not be filed, so the first mate may propose again.
#[tauri::command(async)]
pub fn proof_tools_propose_release(
    app: tauri::AppHandle,
    folder: String,
    tool_id: String,
    revision: u64,
) -> Result<bool, String> {
    release(&crate::plugins::host(&app)?, &folder, &tool_id, revision)
}

#[cfg(test)]
mod tests {
    use std::fs::OpenOptions;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, SystemTime};

    use serde_json::{json, Value};

    use super::*;

    struct Tmp(PathBuf);

    impl Tmp {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("hivra pt1 {label} plüg {}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Tmp(crate::fs::canonical(&dir).unwrap())
        }
        fn path(&self) -> &Path {
            &self.0
        }
        /// A project folder with these files.
        fn project(&self, name: &str, files: &[(&str, &str)]) -> String {
            let dir = self.0.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            for (rel, text) in files {
                std::fs::write(dir.join(rel), text).unwrap();
            }
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

    fn saved(host: &Host) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(host.root.join("verify-offers.json")).unwrap(),
        )
        .unwrap()
    }

    fn display(folder: &str) -> String {
        folder_display(folder).unwrap()
    }

    const NODE_PROJECT: &[(&str, &str)] =
        &[("package.json", r#"{"devDependencies":{"vitest":"4.0.0"}}"#)];

    #[test]
    fn the_first_claim_claims_and_every_later_one_is_already_proposed() {
        let tmp = Tmp::new("claim");
        let host = host(&tmp);
        let folder = tmp.project("proj one", NODE_PROJECT);
        assert_eq!(status(&host, &folder, "fast-check").unwrap(), Status::Open);
        assert_eq!(
            claim(&host, &folder, "fast-check").unwrap(),
            Claim::Claimed { revision: 1 }
        );
        assert_eq!(
            claim(&host, &folder, "fast-check").unwrap(),
            Claim::Already(Status::Proposed)
        );
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Proposed
        );
        // Another tool in the same folder is still open, and another folder is untouched.
        assert_eq!(status(&host, &folder, "stryker").unwrap(), Status::Open);
        let other = tmp.project("proj two", NODE_PROJECT);
        assert_eq!(status(&host, &other, "fast-check").unwrap(), Status::Open);
        // The record: one entry, the revision moved once.
        let file = saved(&host);
        assert_eq!(file["revision"], 1);
        assert_eq!(
            file["tools"][display(&folder).as_str()]["fast-check"],
            json!({ "state": "proposed", "claimedAt": 1 })
        );
        // The same folder spelled another way is the same folder.
        let spelled = format!("{folder}/../proj one");
        assert_eq!(
            claim(&host, &spelled, "fast-check").unwrap(),
            Claim::Already(Status::Proposed)
        );
    }

    #[test]
    fn of_two_callers_at_once_exactly_one_claims() {
        let tmp = Tmp::new("race");
        let host = Arc::new(host(&tmp));
        let folder = Arc::new(tmp.project("proj", NODE_PROJECT));
        let gate = Arc::new(Barrier::new(2));
        let runs: Vec<_> = (0..2)
            .map(|_| {
                let (host, folder, gate) = (host.clone(), folder.clone(), gate.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    // A lock held by the other caller is a reason to try again, not a final failure.
                    for _ in 0..50 {
                        match claim(&host, &folder, "stryker") {
                            Err(why) if why.contains("Try again") => continue,
                            other => return other,
                        }
                    }
                    Err("never got the lock".to_string())
                })
            })
            .collect();
        let results: Vec<Claim> = runs
            .into_iter()
            .map(|run| run.join().unwrap().unwrap())
            .collect();
        let claimed = results
            .iter()
            .filter(|result| matches!(result, Claim::Claimed { .. }))
            .count();
        assert_eq!(claimed, 1, "{results:?}");
        assert!(
            results.contains(&Claim::Already(Status::Proposed)),
            "{results:?}"
        );
        assert_eq!(saved(&host)["revision"], 1);
    }

    #[test]
    fn a_declined_tool_is_never_claimable_again() {
        let tmp = Tmp::new("decline");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        claim(&host, &folder, "fast-check").unwrap();
        assert!(decline(&host, &folder, "fast-check").unwrap());
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Declined
        );
        assert_eq!(
            claim(&host, &folder, "fast-check").unwrap(),
            Claim::Already(Status::Declined)
        );
        // Idempotent: nothing changes the second time, not even the revision.
        let revision = saved(&host)["revision"].clone();
        assert!(!decline(&host, &folder, "fast-check").unwrap());
        assert_eq!(saved(&host)["revision"], revision);
        // A tool that was never proposed can be turned down too.
        assert!(decline(&host, &folder, "proptest").unwrap());
        assert_eq!(
            claim(&host, &folder, "proptest").unwrap(),
            Claim::Already(Status::Declined)
        );
    }

    #[test]
    fn release_undoes_only_the_claim_it_names() {
        let tmp = Tmp::new("release");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        let Claim::Claimed { revision } = claim(&host, &folder, "fast-check").unwrap() else {
            panic!("the first claim claims");
        };
        // A stale or made-up revision changes nothing.
        assert!(!release(&host, &folder, "fast-check", revision + 1).unwrap());
        assert!(!release(&host, &folder, "fast-check", 0).unwrap());
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Proposed
        );
        // Another window's write in between (the Verify offer's own decline) does not strand the claim.
        let other = tmp.project("proj two", NODE_PROJECT);
        assert!(verify::decline(&host, &other, revision).unwrap().applied);
        assert!(release(&host, &folder, "fast-check", revision).unwrap());
        assert_eq!(status(&host, &folder, "fast-check").unwrap(), Status::Open);
        assert!(
            saved(&host)["tools"].is_null(),
            "an empty record is not kept"
        );
        // After a release the first mate can propose again, and the old claim's release no longer reaches the new one.
        let Claim::Claimed { revision: again } = claim(&host, &folder, "fast-check").unwrap()
        else {
            panic!("a released tool can be claimed again");
        };
        assert_ne!(again, revision);
        assert!(!release(&host, &folder, "fast-check", revision).unwrap());
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Proposed
        );
        // A declined tool is not undone by a release.
        decline(&host, &folder, "fast-check").unwrap();
        assert!(!release(&host, &folder, "fast-check", again).unwrap());
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Declined
        );
    }

    #[test]
    fn an_old_offer_file_still_reads_and_the_verify_offer_keeps_working() {
        let tmp = Tmp::new("old");
        let host = host(&tmp);
        let folder = tmp.project(
            "proj",
            &[("package.json", r#"{"dependencies":{"vite":"6"}}"#)],
        );
        let path = host.root.join("verify-offers.json");
        // The shape the file had before: a revision and the folders Verify was declined for. Unknown fields were always ignored.
        std::fs::write(
            &path,
            json!({ "revision": 3, "declined": ["/somewhere/else"], "futureField": true })
                .to_string(),
        )
        .unwrap();
        let offer = verify::offer_for(&host, &folder).unwrap();
        assert_eq!(offer.revision, 3);
        assert!(!offer.declined);
        assert_eq!(
            statuses(&host, &folder).unwrap()["fast-check"],
            Status::Open
        );
        assert_eq!(
            claim(&host, &folder, "fast-check").unwrap(),
            Claim::Claimed { revision: 4 }
        );
        // Written back, the old part is kept as it was.
        let file = saved(&host);
        assert_eq!(file["revision"], 4);
        assert_eq!(file["declined"], json!(["/somewhere/else"]));
        // And the Verify offer's own decline still works on top of it, keeping the proposal.
        let result = verify::decline(&host, &folder, 4).unwrap();
        assert!(result.applied);
        assert_eq!(result.offer.revision, 5);
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Proposed
        );
        // A file with no tools at all is not rewritten with an empty record.
        std::fs::write(&path, json!({ "revision": 1, "declined": [] }).to_string()).unwrap();
        verify::decline(&host, &folder, 1).unwrap();
        assert!(saved(&host).get("tools").is_none());
    }

    #[test]
    fn a_tools_entry_this_build_cant_read_is_left_out_not_fatal() {
        let tmp = Tmp::new("lenient");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        let mut folders = serde_json::Map::new();
        folders.insert(
            display(&folder),
            json!({
                "fast-check": { "state": "someStateFromTheFuture" },
                "stryker": { "state": "declined" },
                "proptest": "nonsense"
            }),
        );
        folders.insert("/elsewhere".to_string(), json!(7));
        std::fs::write(
            host.root.join("verify-offers.json"),
            json!({ "revision": 2, "declined": [], "tools": folders }).to_string(),
        )
        .unwrap();
        // The whole file reads (the Verify offer is not taken down), and only what makes sense is kept.
        assert!(verify::offer_for(&host, &folder).is_ok());
        let all = statuses(&host, &folder).unwrap();
        assert_eq!(all["stryker"], Status::Declined);
        assert_eq!(all["fast-check"], Status::Open);
        assert_eq!(all["proptest"], Status::Open);
        // A `tools` that isn't an object at all is no record either.
        std::fs::write(
            host.root.join("verify-offers.json"),
            json!({ "revision": 2, "declined": [], "tools": ["x"] }).to_string(),
        )
        .unwrap();
        assert_eq!(status(&host, &folder, "stryker").unwrap(), Status::Open);
    }

    #[test]
    fn an_unknown_tool_or_a_missing_folder_is_refused_and_writes_nothing() {
        let tmp = Tmp::new("refuse");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        assert_eq!(
            claim(&host, &folder, "rm-rf").unwrap_err(),
            "That isn't a proof tool I know."
        );
        assert!(status(&host, &folder, "").is_err());
        assert!(release(&host, &folder, "nope", 1).is_err());
        assert!(decline(&host, &folder, "nope").is_err());
        let gone = tmp.path().join("not there").display().to_string();
        let error = claim(&host, &gone, "fast-check").unwrap_err();
        assert!(error.contains("isn't on this computer"), "{error}");
        assert!(claim(&host, "  ", "fast-check").is_err());
        let file = tmp.path().join("a file");
        std::fs::write(&file, "x").unwrap();
        assert!(claim(&host, &file.display().to_string(), "fast-check").is_err());
        assert!(!host.root.join("verify-offers.json").exists());
        assert!(!host.root.join("verify-offers.lock").exists());
    }

    #[test]
    fn a_broken_offer_file_is_an_error_and_is_left_as_it_was() {
        let tmp = Tmp::new("broken");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        let path = host.root.join("verify-offers.json");
        std::fs::write(&path, "{").unwrap();
        assert!(claim(&host, &folder, "fast-check").is_err());
        assert!(status(&host, &folder, "fast-check").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
    }

    #[test]
    fn the_verify_plugins_own_not_now_is_a_not_now_to_e2e_and_only_e2e() {
        let tmp = Tmp::new("e2e");
        let host = host(&tmp);
        let folder = tmp.project(
            "proj",
            &[("package.json", r#"{"dependencies":{"vite":"6"}}"#)],
        );
        assert_eq!(status(&host, &folder, "e2e").unwrap(), Status::Open);
        assert!(verify::decline(&host, &folder, 0).unwrap().applied);
        assert_eq!(status(&host, &folder, "e2e").unwrap(), Status::Declined);
        assert_eq!(
            claim(&host, &folder, "e2e").unwrap(),
            Claim::Already(Status::Declined)
        );
        assert_eq!(status(&host, &folder, "playwright").unwrap(), Status::Open);
        assert_eq!(statuses(&host, &folder).unwrap()["e2e"], Status::Declined);
        // It wrote no proposal of its own.
        assert!(saved(&host).get("tools").is_none());
    }

    #[test]
    fn the_decision_key_is_stable_per_folder_and_in_the_gates_key_alphabet() {
        assert_eq!(fnv1a(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a("a"), 0xaf63_dc4c_8601_ec8c);
        let tag = folder_tag("/Users/ash/Projects/tally app");
        assert_eq!(tag.len(), 12);
        assert!(
            tag.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
            "{tag}"
        );
        assert_eq!(tag, folder_tag("/Users/ash/Projects/tally app"));
        assert_ne!(tag, folder_tag("/Users/ash/Projects/tally-app"));
        for tool in catalogue::tools() {
            let key = decision_key(tool, "/Users/ash/Projects/tally app");
            assert!(key.starts_with("proof-tools/"), "{key}");
            assert!(key.len() <= 120, "{key}");
            assert!(
                key.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'/')),
                "{key}"
            );
            let (found, parsed) = parse_key(&key).unwrap();
            assert_eq!(found.id, tool.id);
            assert_eq!(parsed, tag);
        }
        // Not proposals: another prefix, an unknown tool, a bad tag, no tag.
        for other in [
            "retention-policy",
            "proof-tools/nope/0123456789ab",
            "proof-tools/fast-check/XYZ",
            "proof-tools/fast-check/0123456789AB",
            "proof-tools/fast-check",
            "gate/proof-tools/fast-check/0123456789ab",
        ] {
            assert!(parse_key(other).is_none(), "{other}");
        }
    }

    #[test]
    fn answering_not_now_declines_the_folder_and_nothing_else_does() {
        let tmp = Tmp::new("answer");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        let other = tmp.project("proj two", NODE_PROJECT);
        let tool = catalogue::find("fast-check").unwrap();
        let key = decision_key(tool, &display(&folder));
        let other_key = decision_key(tool, &display(&other));
        claim(&host, &folder, "fast-check").unwrap();
        claim(&host, &other, "fast-check").unwrap();
        // The person said yes: it stays proposed (the worker the first mate briefs adds it).
        assert!(!on_answer_in(&host, &key, "Add it"));
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Proposed
        );
        // A different key, or a different tool's, changes nothing.
        assert!(!on_answer_in(&host, "retention-policy", "Not now"));
        assert!(!on_answer_in(&host, "gate/x", "Not now"));
        assert!(!on_answer_in(
            &host,
            "proof-tools/nope/0123456789ab",
            "Not now"
        ));
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Proposed
        );
        // The words may be typed any way.
        assert!(on_answer_in(&host, &key, "  not NOW "));
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Declined
        );
        // Only that folder's.
        assert_eq!(
            status(&host, &other, "fast-check").unwrap(),
            Status::Proposed
        );
        // Again: nothing left to change.
        assert!(!on_answer_in(&host, &key, "Not now"));
        assert!(on_answer_in(&host, &other_key, "Not now"));
        assert_eq!(
            status(&host, &other, "fast-check").unwrap(),
            Status::Declined
        );
        // A key for a folder that has no record is no change.
        let stranger = decision_key(tool, "/never/proposed");
        assert!(!on_answer_in(&host, &stranger, "Not now"));
    }

    #[test]
    fn the_revision_is_shared_so_a_stale_writer_loses() {
        let tmp = Tmp::new("revision");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        claim(&host, &folder, "fast-check").unwrap();
        claim(&host, &folder, "stryker").unwrap();
        assert_eq!(saved(&host)["revision"], 2);
        // A Verify decline that read the revision before those claims loses, and the proposals stand.
        let lost = verify::decline(&host, &folder, 0).unwrap();
        assert!(!lost.applied);
        assert_eq!(status(&host, &folder, "stryker").unwrap(), Status::Proposed);
        let won = verify::decline(&host, &folder, 2).unwrap();
        assert!(won.applied);
        assert_eq!(won.offer.revision, 3);
        assert_eq!(
            status(&host, &folder, "fast-check").unwrap(),
            Status::Proposed
        );
        // A decline here bumps it too.
        decline(&host, &folder, "fast-check").unwrap();
        assert_eq!(saved(&host)["revision"], 4);
    }

    #[test]
    fn a_held_lock_is_retried_not_final_and_a_stale_one_is_taken() {
        let tmp = Tmp::new("lock");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        let lock = host.root.join("verify-offers.lock");
        std::fs::write(&lock, b"held").unwrap();
        let error = claim(&host, &folder, "fast-check").unwrap_err();
        assert!(error.contains("Try again"), "{error}");
        assert!(!host.root.join("verify-offers.json").exists());
        OpenOptions::new()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(31))
            .unwrap();
        assert_eq!(
            claim(&host, &folder, "fast-check").unwrap(),
            Claim::Claimed { revision: 1 }
        );
        assert!(!lock.exists());
    }

    // ---- the proposal, with the stacks read from real files ------------------------------------------------------------

    #[test]
    fn a_tool_that_fits_and_is_not_there_is_claimed_with_the_question_to_file() {
        let tmp = Tmp::new("propose");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        let first = propose_claim_in(&host, &folder, "fast-check").unwrap();
        assert!(first.claimed);
        assert_eq!(first.status, Status::Proposed);
        assert_eq!(first.revision, 1);
        assert_eq!(
            first.question,
            "Add fast-check to catch properties hold for generated inputs, not just the examples?"
        );
        assert_eq!(first.options, ["Add it", "Not now"]);
        assert_eq!(first.recommended, "Add it");
        assert_eq!(
            first.key,
            decision_key(catalogue::find("fast-check").unwrap(), &display(&folder))
        );
        assert_eq!(
            first.tool.install,
            "npm install --save-dev fast-check@4.10.2"
        );
        assert_eq!(first.tool.licence, "MIT");
        // Asked once: the second proposal files nothing.
        let second = propose_claim_in(&host, &folder, "fast-check").unwrap();
        assert!(!second.claimed);
        assert_eq!(second.status, Status::Proposed);
        assert!(
            second.note.contains("won't be proposed again"),
            "{}",
            second.note
        );
        // "Not now" is remembered.
        assert!(on_answer_in(&host, &first.key, "Not now"));
        let third = propose_claim_in(&host, &folder, "fast-check").unwrap();
        assert!(!third.claimed);
        assert_eq!(third.status, Status::Declined);
        assert!(
            third.note.contains("Don't propose it again"),
            "{}",
            third.note
        );
        // Nothing was installed or created in the project.
        assert_eq!(
            std::fs::read_dir(&folder).unwrap().count(),
            1,
            "only the package.json the project already had"
        );
    }

    #[test]
    fn a_tool_the_project_has_or_that_does_not_fit_is_not_proposed_and_nothing_is_recorded() {
        let tmp = Tmp::new("nofit");
        let host = host(&tmp);
        let has = tmp.project(
            "has",
            &[(
                "package.json",
                r#"{"devDependencies":{"fast-check":"4.10.2"}}"#,
            )],
        );
        let there = propose_claim_in(&host, &has, "fast-check").unwrap();
        assert!(!there.claimed);
        assert!(there.note.contains("already has"), "{}", there.note);
        let rust_only = tmp.project("rust", &[("Cargo.toml", "[package]\nname = \"x\"\n")]);
        let unfit = propose_claim_in(&host, &rust_only, "fast-check").unwrap();
        assert!(!unfit.claimed);
        assert_eq!(unfit.status, Status::Open);
        assert!(unfit.note.contains("doesn't fit"), "{}", unfit.note);
        // But a Rust project is offered a Rust tool.
        assert!(
            propose_claim_in(&host, &rust_only, "proptest")
                .unwrap()
                .claimed
        );
        let nothing = tmp.project("empty", &[]);
        assert!(
            !propose_claim_in(&host, &nothing, "stryker")
                .unwrap()
                .claimed
        );
        // Unknown tool, missing folder.
        assert!(propose_claim_in(&host, &has, "install-everything").is_err());
        let gone = tmp.path().join("gone").display().to_string();
        assert!(propose_claim_in(&host, &gone, "fast-check").is_err());
        // Only the one proposal that was made is on record.
        let file = saved(&host);
        let tools = file["tools"].as_object().unwrap();
        assert_eq!(tools.len(), 1);
    }

    #[test]
    fn the_claim_view_is_camel_case_for_the_webview() {
        let tmp = Tmp::new("shape");
        let host = host(&tmp);
        let folder = tmp.project("proj", NODE_PROJECT);
        let view =
            serde_json::to_value(propose_claim_in(&host, &folder, "stryker").unwrap()).unwrap();
        let mut keys: Vec<&str> = view
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "claimed",
                "key",
                "note",
                "options",
                "question",
                "recommended",
                "revision",
                "status",
                "tool"
            ]
        );
        assert_eq!(view["status"], "proposed");
        let mut tool: Vec<&str> = view["tool"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        tool.sort_unstable();
        assert_eq!(
            tool,
            ["external", "id", "install", "licence", "name", "pinned", "proves", "repo"]
        );
    }
}
