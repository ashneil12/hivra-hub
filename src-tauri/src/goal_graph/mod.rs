// Copyright (c) 2026 oh-my-hermes contributors
// SPDX-License-Identifier: MIT
// Source: https://github.com/rlaope/oh-my-hermes (src/plugin_bundle/omh/dag_core.py, dag_run.py) at 2676c33
//
// WP-91: the goal graph. A big orchestration run is a goal, not just a list of jobs, and this module is the rules
// behind that: the finish-line check that has to fail before any work starts, the graph's topology, the write scopes
// two tasks may not share at once, a handoff for every node, repair cycles, and the run verdict the app computes
// from the record rather than from any agent's words.
//
// It holds no second scheduler and no second run record: `orchestration.ts` keeps the run, and every rule here is a
// pure function over a small view of it that the webview sends in and stores the answer of.

pub mod check;
pub mod handoff;
pub mod plan;
pub mod record;
pub mod topology;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// The role a node plays in the run. `build` is the plain one; only a `verify` node verifies the goal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    #[default]
    Build,
    Verify,
}

impl Role {
    pub fn parse(word: &str) -> Option<Role> {
        match word {
            "build" => Some(Role::Build),
            "verify" => Some(Role::Verify),
            _ => None,
        }
    }

    pub fn is_verify(self) -> bool {
        self == Role::Verify
    }
}

/// What the app knows about one node of the run, as the rules read it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalNode {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub role: Option<Role>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub write_scope: Vec<String>,
    /// The task is accepted: reviewed, with its changes integrated.
    #[serde(default)]
    pub accepted: bool,
    /// WP-40's word on the task's own gates, when anything ran them: `passed`, `failed`, `notRun` or `held`.
    /// `None` means no gate ran, which is not a pass; any word that is not `passed` is not a pass either.
    #[serde(default)]
    pub gate_outcome: Option<String>,
    /// The task failed or was blocked, and nothing accepted stands in for it.
    #[serde(default)]
    pub failed: bool,
    /// Dropped by the person or the lead; it is not part of the work any more.
    #[serde(default)]
    pub cancelled: bool,
    /// A handoff file exists inside the worker's checkout, with its size and digest.
    #[serde(default)]
    pub handoff: Option<Handoff>,
    /// The failed task this one repairs, when it is a repair node.
    #[serde(default)]
    pub repairs: Option<String>,
    /// The person approved an irreversible step before it started; `None` when the task is not irreversible.
    #[serde(default)]
    pub irreversible: Option<Irreversible>,
}

/// An irreversible step's approval, as the record holds it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Irreversible {
    /// The one-line reason the task cannot be undone.
    pub reason: String,
    /// The WP-14 decision's stable key, and whether the person has answered it.
    pub key: String,
    #[serde(default)]
    pub answered: bool,
}

/// A node's handoff file: where it is, and whether the lead opened it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    /// The canonical path inside the worker's checkout.
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    /// The lead opened it before accepting the task.
    #[serde(default)]
    pub read: bool,
}

/// What the app ran of the finish line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckOutcome {
    /// It ran and met what the proposal expected.
    Passed,
    /// It ran and did not meet it.
    Failed,
    /// It could not run, or ran out of time. Never a pass and never a final failure.
    NotRun,
}

/// One run of the finish-line check.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub outcome: CheckOutcome,
    pub exit_code: Option<i32>,
    /// The end of what it printed, capped.
    pub output: String,
    /// Which layer ran it: `app`, `worker` or `delivery` (WP-81). Recorded once per command.
    pub layer: String,
    pub at: u64,
}

/// The whole run, as the rules read it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    #[serde(default)]
    pub goal: String,
    pub nodes: Vec<GoalNode>,
    /// The finish-line check's baseline on the untouched base, when one was taken.
    #[serde(default)]
    pub baseline: Option<CheckRun>,
    /// The app's latest run of the check in the integrated checkout.
    #[serde(default)]
    pub latest: Option<CheckRun>,
    /// Repairs taken per failed root, oldest first (each entry is one cycle's node ids).
    #[serde(default)]
    pub repairs: std::collections::BTreeMap<String, Vec<Vec<String>>>,
    /// Extend rounds taken.
    #[serde(default)]
    pub extends: u32,
}

/// The verdict: whether the run's goal is proved, and why not when it isn't.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// Every task accepted, every gate passed, the verify task accepted with its handoff read, and the app's own run
    /// of the finish-line check green.
    Verified,
    /// A check or a gate failed.
    Failed,
    /// Anything else, with the reasons named.
    Unverified,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The goal the run states, one line. Shown above the graph.
    pub goal: String,
    pub verdict: Verdict,
    /// One reason code per thing left undone, e.g. `verify_open:<id>`.
    pub reasons: Vec<String>,
    /// The nodes by layer, in the run's order within each.
    pub layers: Vec<Vec<String>>,
    pub critical_path: Vec<String>,
    pub bottlenecks: Vec<Bottleneck>,
    /// Advisory findings; they never reject a run.
    pub lint: Vec<String>,
    /// The nodes that can start now, in the run's order.
    pub ready: Vec<String>,
    /// Repair cycles left per failed node.
    pub cycles_left: std::collections::BTreeMap<String, u32>,
    /// Failed nodes whose next cycle is the re-plan, not another try at the same approach.
    pub replan: Vec<String>,
    /// Extend rounds left for a re-plan that adds nodes.
    pub extends_left: u32,
    /// The verify node's id, once the graph has exactly one.
    pub verify: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bottleneck {
    pub node: String,
    pub blocks: usize,
}

/// A refusal: the reason code, and one plain sentence the person or the lead reads.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub reason: String,
    pub say: String,
}

impl Refusal {
    pub fn new(reason: &str, say: impl Into<String>) -> Refusal {
        Refusal {
            reason: reason.to_string(),
            say: say.into(),
        }
    }

    /// The one line a caller shows.
    pub fn message(&self) -> String {
        self.say.clone()
    }
}

/// The whole graph, as one answer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphAnswer {
    /// `None` when the graph holds: nothing to report.
    pub refusal: Option<Refusal>,
    pub report: Report,
}

/// Every rule over one run, in one call, so the webview stores one answer.
#[tauri::command(async)]
pub fn goal_graph_report(run: RunView) -> GraphAnswer {
    record::report(&run)
}

/// Check a proposal's graph before any worker starts: references, a cycle, two tasks that can run at the same time
/// sharing a write scope, and the one verify task that has to follow every task that writes.
#[tauri::command(async)]
pub fn goal_graph_check_plan(nodes: Vec<plan::ProposedNode>) -> Result<plan::PlanAnswer, Refusal> {
    plan::check_plan(nodes)
}

/// Check one repair task before it is added to the run: its dependencies, and the write scopes it shares with the
/// nodes that can still run. A repair may share its own failed root's files.
#[tauri::command(async)]
pub fn goal_graph_check_repair(run: RunView, node: GoalNode) -> Result<(), Refusal> {
    record::check_repair(&run, &node)
}

/// Run the finish-line check once, in `cwd`, and report what happened. A timeout or a command that cannot start is
/// `notRun`, never a final failure and never a pass.
///
/// The spec crosses a process boundary, so it is checked here too: `parse_spec` is the bounds rule for a value this
/// side did not build.
#[tauri::command(async)]
pub fn goal_graph_run_check(
    app: AppHandle,
    cwd: String,
    spec: check::CheckSpec,
) -> Result<CheckRun, String> {
    let value = serde_json::to_value(&spec).map_err(|error| error.to_string())?;
    let checked = check::parse_spec(&value).map_err(|refusal| refusal.say)?;
    check::run(&app, &cwd, &checked)
}

/// Read a worker's handoff file, proving it is inside the checkout, and answer its digest and text.
#[tauri::command(async)]
pub fn goal_graph_read_handoff(
    checkout: String,
    task_id: String,
) -> Result<handoff::HandoffFile, Refusal> {
    handoff::read(&checkout, &task_id)
}
