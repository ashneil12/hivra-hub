//! PT-1: proof tools in the product. The open-source testing tools from the shipping-confidence research (property
//! libraries, mutation testers, end-to-end and API testers, pattern scanners) are real, credited options for the
//! person's own projects.
//!
//! **The app never installs a tool into a person's project.** It uses the tools the project ALREADY has, and a first mate
//! may propose one that fits, once per project (`offers`). Nothing here runs `install`: that command is only shown.
//!
//! - `catalogue`: the data file both sides read (`src/features/proofTools/model/proofTools.json`).
//! - `detect`: which tools fit a checkout's stacks and which it already has. Reuses `plugins::verify`'s package.json reading
//!   and web/mobile stack detection; adds Cargo.toml, pyproject.toml, requirements and OpenAPI reads (bounded, plain text).
//! - `diff`: a diff as the ranges a tool is scoped to (Stryker has no git option, so the app turns the diff into ranges).
//! - `command`: a catalogue command template filled with arguments. File names and ranges go to the child in the
//!   environment and are named as quoted `"$VAR"` words, so a name with a space, a quote or a `;` is one argument and is
//!   never part of the shell line.
//! - `trim`: a run's output cut down to what a person acts on: the failures, the survivors, the findings.
//! - `run`: runs the installed, fitting tools over a change through the SAME sandboxed runner the checks use (`app_env` is
//!   that runner's door: `verify_stage::run_proof_line`, or `run_copy_line_with` in the running checker's read-only copy).
//! - `offers`: the per-project proposal record, kept in the Verify plugin's `verify-offers.json` under its lock.
//! - `mcp`: the first mate's `proof_tools` tool.
//!
//! Honest by construction, as the ship check and the gates are: a tool that could not run is "could not run", never a
//! pass; zero tests run is "could not run"; no installed tool means the gate is not added and nothing reads as a pass.

pub mod app_env;
pub mod catalogue;
pub mod command;
pub mod detect;
pub mod diff;
pub mod mcp;
pub mod offers;
pub mod run;
pub mod trim;

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

pub use catalogue::{Kind, Stack, Tool};

/// How one tool's run ended, in the words the ship check and the gates use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// It ran and found nothing wrong.
    Passed,
    /// It ran and found a problem: a failing test, a surviving mutant, an error finding.
    Failed,
    /// It could not run (it didn't start, timed out, ran zero tests, errored). Never a pass.
    CouldNotRun,
    /// There was nothing for it to do on this change. Not a pass either.
    NotRun,
}

/// One tool's finished run, trimmed to what a person acts on.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolRun {
    pub tool: &'static Tool,
    pub outcome: Outcome,
    /// One plain line: what ran, or why it could not.
    pub detail: String,
    /// The failures, survivors or findings, one plain line each, already capped.
    pub lines: Vec<String>,
    /// The command as a person reads it, when one was run.
    pub command: Option<String>,
    /// The end of what it printed, when it failed or could not run.
    pub tail: Option<String>,
    pub seconds: f64,
}

/// What a change is, read once: where it started, which files changed and the diff (zero context lines). Paths are
/// checkout-relative with `/` between parts, as git prints them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scope {
    /// The revision the diff is against (`{base}`). Absent when the checkout has none.
    pub base: Option<String>,
    pub changed: Vec<String>,
    /// A unified diff of the change at `-U0`, with each new untracked file as a diff of all its lines.
    pub diff: String,
}

/// The result of the project's own tests in this round, which is where a property library's properties run. `output` is
/// the end of what the run printed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TestRun {
    pub outcome: Outcome,
    pub output: String,
}

/// Which tools a run covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pick {
    /// Every installed tool that fits.
    All,
    /// The running checker's read-only copy: only a replay of the end-to-end tests (e2e, Playwright).
    Replay,
}

// ---- what the app tells a first mate, the brief and Settings -------------------------------------------------------------

/// One tool that fits a project, as the list shows it. `status` is the once-per-project proposal record (`offers`): it only
/// matters while the project doesn't have the tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    pub id: String,
    pub name: String,
    pub proves: String,
    pub how_to_use: String,
    pub kind: Kind,
    pub external: bool,
    pub installed: bool,
    pub status: offers::Status,
}

/// The tools that fit a project and which of them it has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ListView {
    pub stacks: Vec<Stack>,
    pub tools: Vec<ToolView>,
}

/// `detection` as the list the webview reads. Only tools that fit appear, in catalogue order. A tool with no record is `open`.
pub fn list_view(
    detection: &detect::Detection,
    statuses: &BTreeMap<String, offers::Status>,
) -> ListView {
    ListView {
        stacks: detection.stacks.clone(),
        tools: detection
            .fitting
            .iter()
            .map(|found| ToolView {
                id: found.tool.id.clone(),
                name: found.tool.name.clone(),
                proves: found.tool.proves.clone(),
                how_to_use: found.tool.how_to_use.clone(),
                kind: found.tool.kind,
                external: found.tool.external,
                installed: found.installed,
                status: statuses
                    .get(&found.tool.id)
                    .copied()
                    .unwrap_or(offers::Status::Open),
            })
            .collect(),
    }
}

/// Which tools fit `folder` and which it has. In a checkout of a project the app knows, a program rule (`cargo mutants
/// --version`) is asked through the sandboxed runner; anywhere else only the files are read.
pub fn detect_folder(app: &tauri::AppHandle, folder: &Path) -> detect::Detection {
    match crate::project_actions::checkout_of_project(folder) {
        Ok((main, checkout)) => {
            run::detect_in(&checkout, &app_env::AppEnv::checkout(app, &main, &checkout))
        }
        Err(_) => detect::detect(folder, &detect::NoProbe),
    }
}

/// The proof tools that fit this folder and which it has: a first mate's `list`, the brief's section and Settings read it.
#[tauri::command(async)]
pub fn proof_tools_list(app: tauri::AppHandle, folder: String) -> Result<ListView, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("Name a project folder.".into());
    }
    let root = crate::fs::canonical(crate::fs::expand_home(folder))
        .map_err(|_| "That folder isn't on this computer.".to_string())?;
    if !root.is_dir() {
        return Err("That folder isn't on this computer.".into());
    }
    let detection = detect_folder(&app, &root);
    // A record that can't be read changes nothing here: a proposal can't be filed against it either (`offers::claim`).
    let statuses = crate::plugins::host(&app)
        .and_then(|host| offers::statuses(&host, folder))
        .unwrap_or_default();
    Ok(list_view(&detection, &statuses))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(id: &str, installed: bool) -> detect::Found {
        detect::Found {
            tool: catalogue::find(id).expect("in the catalogue"),
            installed,
        }
    }

    #[test]
    fn the_list_names_only_tools_that_fit_and_marks_what_the_project_has() {
        let detection = detect::Detection {
            stacks: vec![Stack::Node, Stack::Web],
            fitting: vec![
                found("fast-check", true),
                found("stryker", false),
                found("playwright", false),
            ],
        };
        let mut statuses = BTreeMap::new();
        statuses.insert("stryker".to_string(), offers::Status::Declined);
        statuses.insert("playwright".to_string(), offers::Status::Proposed);
        let list = list_view(&detection, &statuses);
        assert_eq!(list.stacks, vec![Stack::Node, Stack::Web]);
        let seen: Vec<(&str, bool, offers::Status)> = list
            .tools
            .iter()
            .map(|tool| (tool.id.as_str(), tool.installed, tool.status))
            .collect();
        assert_eq!(
            seen,
            [
                ("fast-check", true, offers::Status::Open),
                ("stryker", false, offers::Status::Declined),
                ("playwright", false, offers::Status::Proposed),
            ]
        );
    }

    #[test]
    fn the_list_is_camel_case_json_the_webview_reads() {
        let detection = detect::Detection {
            stacks: vec![Stack::Rust],
            fitting: vec![found("proptest", false)],
        };
        let json = serde_json::to_value(list_view(&detection, &BTreeMap::new())).unwrap();
        assert_eq!(json["stacks"], serde_json::json!(["rust"]));
        let tool = &json["tools"][0];
        assert_eq!(tool["id"], "proptest");
        assert_eq!(tool["kind"], "property");
        assert_eq!(tool["status"], "open");
        assert_eq!(tool["installed"], false);
        assert_eq!(tool["external"], false);
        assert!(tool["howToUse"].as_str().unwrap().contains("proptest"));
    }
}
