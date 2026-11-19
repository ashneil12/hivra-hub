//! PT-4: proactive proposals at the ship check.
//!
//! When a ship check runs and the project has a proof tool that fits it and isn't installed, the first mate puts it to the person
//! as PT-1's one Needs-you proposal (`proof_tools::offers`): once per project per tool, a remembered "Not now" is never asked
//! again, and the Verify plugin's own decline counts for `e2e`. This module only DECIDES which tools to put forward, in order,
//! at most `CAP` for one ship check. It files nothing and installs nothing:
//!
//! - the webview files each one through the existing claim and ask path (`agentAppProofTools.ts`), which records the proposal
//!   under the offer file's lock, so two windows or two retries can't ask twice;
//! - adding anything to a person's project still needs their one tap ("Add it"). The app never installs.
//!
//! The most useful first: the end-to-end tools for a project with a screen (the Verify plugin, then Playwright), then the property
//! library for the stack, then the rest in catalogue order. A tool the person switched off, one that is installed, one already
//! proposed and one declined are left out before the cap is counted, so the cap spends on tools that can really be asked.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::delivery::settings::TestingMode;
use crate::proof_tools::{catalogue::Kind, detect::Detection, offers::Status, Tool};

/// The most proposals one ship check puts forward.
pub const CAP: usize = 3;

/// One tool to put to the person: the webview claims it and asks. `name` is the tool as a person reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub tool_id: String,
    pub name: String,
}

/// How useful a tool is to propose first. Lower goes first.
fn rank(tool: &Tool, screen: bool) -> u8 {
    match tool.id.as_str() {
        "e2e" if screen => 0,
        "playwright" if screen => 1,
        _ if tool.kind == Kind::Property => 2,
        _ => 3,
    }
}

/// The tools to put forward, in order, at most `CAP`. `detection` is the project's with the switched-off tools already left out
/// (`Detection::without_off`); `statuses` is where each tool stands for the project (`offers::statuses`): only an open one is a
/// candidate. A tool with no entry is open.
pub fn plan(
    detection: &Detection,
    screen: bool,
    statuses: &BTreeMap<String, Status>,
) -> Vec<Candidate> {
    let mut missing: Vec<&'static Tool> = detection
        .missing()
        .into_iter()
        .filter(|tool| statuses.get(&tool.id).copied().unwrap_or(Status::Open) == Status::Open)
        .collect();
    // A stable sort keeps catalogue order inside a rank.
    missing.sort_by_key(|tool| rank(tool, screen));
    missing
        .into_iter()
        .take(CAP)
        .map(|tool| Candidate {
            tool_id: tool.id.clone(),
            name: tool.name.clone(),
        })
        .collect()
}

/// Whether the project has a screen for this purpose: the Verify plugin's detection says it is a web or mobile app, or Playwright
/// is installed (`whole` is the detection with the switched-off tools still in it, so a switched-off Playwright still counts).
pub fn has_screen(surfaces: &[String], whole: &Detection) -> bool {
    !surfaces.is_empty()
        || whole
            .fitting
            .iter()
            .any(|found| found.tool.id == "playwright" && found.installed)
}

/// What a ship check puts forward: nothing in a mode that tests nothing (a proposal to add a tool the project would never use is
/// noise), else `plan` over the project with its switched-off tools left out.
pub fn candidates(
    mode: TestingMode,
    surfaces: &[String],
    whole: &Detection,
    off: &BTreeSet<String>,
    statuses: &BTreeMap<String, Status>,
) -> Vec<Candidate> {
    if mode == TestingMode::Off {
        return Vec::new();
    }
    let screen = has_screen(surfaces, whole);
    plan(&whole.clone().without_off(off), screen, statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proof_tools::{catalogue, detect::Found, Stack};

    fn found(id: &str, installed: bool) -> Found {
        Found {
            tool: catalogue::find(id).unwrap(),
            installed,
        }
    }

    fn detection(stacks: &[Stack], fitting: Vec<Found>) -> Detection {
        Detection {
            stacks: stacks.to_vec(),
            fitting,
            off: Vec::new(),
        }
    }

    fn ids(list: &[Candidate]) -> Vec<&str> {
        list.iter()
            .map(|candidate| candidate.tool_id.as_str())
            .collect()
    }

    fn none() -> BTreeMap<String, Status> {
        BTreeMap::new()
    }

    /// A web project that has nothing yet: every Node and web tool fits and is missing.
    fn bare_web() -> Detection {
        detection(
            &[Stack::Node, Stack::Web],
            vec![
                found("fast-check", false),
                found("stryker", false),
                found("ast-grep", false),
                found("semgrep", false),
                found("playwright", false),
                found("e2e", false),
            ],
        )
    }

    #[test]
    fn a_fitting_tool_the_project_lacks_is_put_forward() {
        let rust = detection(&[Stack::Rust], vec![found("proptest", false)]);
        assert_eq!(ids(&plan(&rust, false, &none())), ["proptest"]);
    }

    #[test]
    fn an_installed_tool_and_a_project_with_nothing_missing_put_nothing_forward() {
        let have_it = detection(&[Stack::Rust], vec![found("proptest", true)]);
        assert!(plan(&have_it, false, &none()).is_empty());
        assert!(plan(&detection(&[], Vec::new()), false, &none()).is_empty());
    }

    #[test]
    fn a_screen_puts_the_end_to_end_tools_first_then_the_property_library_then_the_rest() {
        let list = plan(&bare_web(), true, &none());
        assert_eq!(
            ids(&list),
            ["e2e", "playwright", "fast-check"],
            "the cap of three spends on the most useful"
        );
        assert_eq!(list.len(), CAP);
        // Without a screen the end-to-end tools are only tools like the others: property library first, then catalogue order.
        let no_screen = plan(&bare_web(), false, &none());
        assert_eq!(ids(&no_screen), ["fast-check", "stryker", "ast-grep"]);
    }

    #[test]
    fn the_cap_is_three_and_the_rest_wait_for_a_later_ship_check() {
        assert_eq!(CAP, 3);
        assert_eq!(plan(&bare_web(), true, &none()).len(), 3);
        assert_eq!(plan(&bare_web(), false, &none()).len(), 3);
    }

    #[test]
    fn a_tool_already_proposed_or_declined_is_not_put_forward_and_does_not_spend_the_cap() {
        let mut statuses = BTreeMap::new();
        statuses.insert("e2e".to_string(), Status::Declined);
        statuses.insert("playwright".to_string(), Status::Proposed);
        let list = plan(&bare_web(), true, &statuses);
        assert_eq!(
            ids(&list),
            ["fast-check", "stryker", "ast-grep"],
            "the two the person already answered or was asked are skipped, and the cap goes on to the next three"
        );
        // Every tool answered: nothing is put forward at all.
        let all: BTreeMap<String, Status> = bare_web()
            .fitting
            .iter()
            .map(|found| (found.tool.id.clone(), Status::Declined))
            .collect();
        assert!(plan(&bare_web(), true, &all).is_empty());
    }

    #[test]
    fn a_tool_the_person_switched_off_is_never_put_forward() {
        let off: BTreeSet<String> = ["e2e", "fast-check"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let list = candidates(
            TestingMode::AtShip,
            &["web".to_string()],
            &bare_web(),
            &off,
            &none(),
        );
        assert_eq!(ids(&list), ["playwright", "stryker", "ast-grep"]);
    }

    #[test]
    fn no_testing_puts_nothing_forward() {
        let list = candidates(
            TestingMode::Off,
            &["web".to_string()],
            &bare_web(),
            &BTreeSet::new(),
            &none(),
        );
        assert!(list.is_empty());
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            let list = candidates(
                mode,
                &["web".to_string()],
                &bare_web(),
                &BTreeSet::new(),
                &none(),
            );
            assert_eq!(list.len(), 3, "{mode:?}");
        }
    }

    #[test]
    fn a_screen_is_a_web_or_mobile_surface_or_playwright_installed_even_if_switched_off() {
        let bare = detection(&[Stack::Node], vec![found("fast-check", false)]);
        assert!(!has_screen(&[], &bare));
        assert!(has_screen(&["mobile".to_string()], &bare));
        assert!(has_screen(&["web".to_string()], &bare));
        let playwright = detection(&[Stack::Node], vec![found("playwright", true)]);
        assert!(has_screen(&[], &playwright));
        // Installed and switched off: it is still the project's, so it still has a screen.
        let off: BTreeSet<String> = ["playwright".to_string()].into_iter().collect();
        let list = candidates(TestingMode::AtShip, &[], &playwright, &off, &none());
        assert!(list.is_empty());
        assert!(has_screen(&[], &playwright));
    }

    #[test]
    fn a_candidate_is_camel_case_json_with_the_name_a_person_reads() {
        let json = serde_json::to_value(plan(&bare_web(), true, &none())).unwrap();
        assert_eq!(json[0]["toolId"], "e2e");
        assert_eq!(json[0]["name"], "e2e");
        assert_eq!(json[1]["name"], "Playwright");
    }
}
