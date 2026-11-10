// Copyright (c) 2026 oh-my-hermes contributors
// SPDX-License-Identifier: MIT
// Source: https://github.com/rlaope/oh-my-hermes src/plugin_bundle/omh/dag_run.py at 2676c33
//
// WP-91: the record rules translated from dag_run.py — the hard rejects over a graph (`_require_graph`), the repair
// caps and the re-plan cycle, the handoff refusal, the goal verdict and `lint`. The codes and the wording are the
// original's where Hivra has the same thing to say; where Hivra's run differs (a node is accepted with its changes
// integrated, a gate is WP-40's, the finish line is a command the app runs itself) the rule is Hivra's and the
// reason codes say so.
//
// One rule the original states differently: dag-ulw treats two nodes as ordered only when one names the other
// directly, so `a -> b -> c` with `a` and `c` sharing a file is refused. Hivra keeps two nodes apart by their
// checkouts and orders them by acceptance, so a plan is refused only when two nodes that really can run at the same
// time share a write scope. Everything else is the original's.

use std::collections::{BTreeMap, BTreeSet};

use super::topology::{self, Parents};
use super::Refusal;
use super::{Bottleneck, CheckOutcome, GoalNode, GraphAnswer, Report, Role, RunView, Verdict};

/// The most nodes a run may hold, matching `orchestration.ts`'s own limit.
pub const MAX_NODES: usize = 40;
/// Repair cycles per failed node, and which of them is the re-plan (`REPLAN_CYCLE`).
pub const MAX_REPAIR_CYCLES: u32 = 2;
pub const REPLAN_CYCLE: u32 = MAX_REPAIR_CYCLES;
/// Extend rounds per run, for a re-plan that adds nodes rather than replacing one.
pub const MAX_EXTEND_ROUNDS: u32 = 2;
/// How many overlapping pairs one refusal names; the rest are counted.
pub const OVERLAPS_NAMED: usize = 20;
/// A run this wide whose critical path is this much of it is one chain wearing a graph's clothes.
const SERIAL_GRAPH_NODES: usize = 5;
const SERIAL_GRAPH_SHARE: f64 = 0.8;

/// The role a node carries, defaulting to `build`.
pub fn role_of(node: &GoalNode) -> Role {
    node.role.unwrap_or_default()
}

/// Whether a node writes anything a verify node has to follow.
pub fn is_producer(node: &GoalNode) -> bool {
    !node.write_scope.is_empty() && !role_of(node).is_verify()
}

/// The parents map the topology functions read.
pub fn parents_of(nodes: &[GoalNode]) -> Parents {
    nodes
        .iter()
        .map(|node| (node.id.clone(), node.depends_on.clone()))
        .collect()
}

/// Everything `id` waits on, directly or not.
pub fn ancestors(id: &str, parents: &Parents) -> BTreeSet<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut frontier: Vec<String> = parents.get(id).cloned().unwrap_or_default();
    while let Some(current) = frontier.pop() {
        if seen.insert(current.clone()) {
            frontier.extend(parents.get(&current).cloned().unwrap_or_default());
        }
    }
    seen
}

/// Whether one of the two is an ancestor of the other: they can never run at the same time.
fn ordered(first: &str, second: &str, parents: &Parents) -> bool {
    ancestors(first, parents).contains(second) || ancestors(second, parents).contains(first)
}

/// The producer nodes no accepted verify node follows, sorted.
///
/// A repair node stands in for the node it repairs, exactly as the original's `verification_misses` does.
pub fn verification_misses(
    nodes: &[GoalNode],
    verifiers: &[&GoalNode],
    skip: &BTreeSet<String>,
) -> Vec<String> {
    let parents = parents_of(nodes);
    let mut covered: BTreeSet<String> = BTreeSet::new();
    for verifier in verifiers {
        covered.extend(ancestors(&verifier.id, &parents));
    }
    let checks: BTreeSet<String> = verifiers.iter().map(|node| node.id.clone()).collect();
    let stand_ins: Vec<String> = nodes
        .iter()
        .filter(|node| {
            node.repairs
                .as_ref()
                .is_some_and(|root| covered.contains(root) || checks.contains(root))
        })
        .map(|node| node.id.clone())
        .collect();
    covered.extend(stand_ins);
    let left_out: BTreeSet<String> = covered.union(skip).cloned().collect();
    let mut out: Vec<String> = nodes
        .iter()
        .filter(|node| is_producer(node) && !left_out.contains(&node.id))
        .map(|node| node.id.clone())
        .collect();
    out.sort();
    out
}

/// A node whose handoff was never opened, or that has none at all.
fn handoff_reason(node: &GoalNode) -> Option<&'static str> {
    match &node.handoff {
        None => Some("handoff_missing"),
        Some(handoff) if !handoff.read => Some("handoff_not_checked"),
        Some(_) => None,
    }
}

/// Whether a refused or unfinished node is one the person dropped.
fn dropped(node: &GoalNode) -> bool {
    node.cancelled
}

/// The id of the node a failed node's latest accepted repair stands in for, or `None`.
fn repaired_by<'a>(nodes: &'a [GoalNode], root: &str) -> Option<&'a GoalNode> {
    nodes
        .iter()
        .find(|node| node.repairs.as_deref() == Some(root) && node.accepted)
}

/// Whether the root's failure is answered: an accepted repair stands in for it.
///
/// A verification is never answered this way: its repair fixes what it found, and only the verification running again
/// says the goal holds (the original's `reruns_root`, `dag_run.py:1490-1491`, and `derive`: "a verification is the
/// exception: the group fixed what it found, and only the root running again says the goal holds").
pub fn is_repaired(nodes: &[GoalNode], root: &str) -> bool {
    let root_is_verify = nodes
        .iter()
        .any(|node| node.id == root && role_of(node).is_verify());
    !root_is_verify && repaired_by(nodes, root).is_some()
}

/// A failed verification whose latest repair group is all accepted: it is due to run again.
///
/// The record's counterpart to the original's `derive`: a verification is never `repaired`, it is set back to
/// `pending` once its repair group is accepted, so the run is not done until the verification itself has passed.
/// The orchestrator does the setting back (the task returns to the queue when the repair is accepted), so this is
/// only consulted where the record still says the verification failed: a repair whose group is accepted means the
/// verification is about to run again, not that the run has failed.
fn rerun_due(run: &RunView, node: &GoalNode) -> bool {
    if !role_of(node).is_verify() || !node.failed {
        return false;
    }
    let Some(latest) = run.repairs.get(&node.id).and_then(|cycles| cycles.last()) else {
        return false;
    };
    !latest.is_empty()
        && latest.iter().all(|member| {
            run.nodes
                .iter()
                .any(|other| &other.id == member && other.accepted && !other.cancelled)
        })
}

/// The task's gates passed. Only the word `passed` says so: no gate result at all, `held` (WP-40's "someone must
/// decide"), `notRun` and any unknown word are not a pass.
pub fn gates_passed(node: &GoalNode) -> bool {
    node.gate_outcome.as_deref().map(str::trim) == Some("passed")
}

/// The task's gates ran and failed.
pub fn gates_failed(node: &GoalNode) -> bool {
    node.gate_outcome.as_deref().map(str::trim) == Some("failed")
}

/// The nodes that can still run or be reviewed: not accepted (done), not dropped, not failed (waiting for a repair).
fn runnable(nodes: &[GoalNode]) -> BTreeSet<String> {
    nodes
        .iter()
        .filter(|node| !node.accepted && !node.cancelled && !node.failed)
        .map(|node| node.id.clone())
        .collect()
}

/// Whether a later record entry stands in for this one.
///
/// A cancelled node is out. A node named in another node's `repairs` is out — except a verification, which is never
/// stood in for: its repair fixes what it found and the verification runs again (`reruns_root`). And among repairs of
/// the same root only the latest cycle is live, so a run that needed a second cycle has one repair, not two.
pub fn superseded(nodes: &[GoalNode], index: usize) -> bool {
    let node = &nodes[index];
    if node.cancelled {
        return true;
    }
    // A verification's repair is never superseded: it is what tells the verification to run again. An older group's
    // repair is out only when a later group of the same root exists.
    if repairs_a_verification(nodes, node) {
        return false;
    }
    nodes.iter().enumerate().any(|(other_index, other)| {
        if other.cancelled {
            return false;
        }
        let later_cycle =
            other_index > index && other.repairs.is_some() && other.repairs == node.repairs;
        let replaces =
            !role_of(node).is_verify() && other.repairs.as_deref() == Some(node.id.as_str());
        later_cycle || replaces
    })
}

/// A verification's repair: it does the fixing, and the verification it repairs runs again. It is not a second
/// verifier, so the run still has exactly one (the original's `reruns_root`, `dag_run.py:1490-1491`).
fn repairs_a_verification(nodes: &[GoalNode], node: &GoalNode) -> bool {
    node.repairs.as_deref().is_some_and(|root| {
        nodes
            .iter()
            .any(|other| other.id == root && role_of(other).is_verify())
    })
}

/// The order a repair adds to the graph: every node that waits on the failed root also waits for the repair, so the
/// repair may write what those nodes write only after it has been accepted.
fn repair_order(run: &RunView, repair_id: &str, root: &str) -> BTreeMap<String, Vec<String>> {
    let parents = parents_of(&run.nodes);
    let mut before: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for node in &run.nodes {
        if node.id == repair_id || node.id == root {
            continue;
        }
        if ancestors(&node.id, &parents).contains(root) {
            before
                .entry(node.id.clone())
                .or_default()
                .push(repair_id.to_string());
        }
    }
    before
}

/// Every repair's order against the root it repairs, for a report over a run that already holds repairs.
fn repair_orders(run: &RunView) -> BTreeMap<String, Vec<String>> {
    let mut before: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for node in &run.nodes {
        let Some(root) = node.repairs.as_deref() else {
            continue;
        };
        if node.cancelled {
            continue;
        }
        for (dependent, repairs) in repair_order(run, &node.id, root) {
            let listed = before.entry(dependent).or_default();
            for repair in repairs {
                if !listed.contains(&repair) {
                    listed.push(repair);
                }
            }
        }
    }
    before
}

/// A repair node may depend only on accepted nodes, or on the failed task it repairs.
fn require_repair_edges(nodes: &[GoalNode]) -> Result<(), Refusal> {
    let accepted: BTreeSet<&str> = nodes
        .iter()
        .filter(|node| node.accepted)
        .map(|node| node.id.as_str())
        .collect();
    for node in nodes {
        if node.cancelled {
            continue;
        }
        let Some(root) = node.repairs.as_deref() else {
            continue;
        };
        let outside: Vec<&str> = node
            .depends_on
            .iter()
            .map(String::as_str)
            .filter(|parent| !accepted.contains(parent) && *parent != root)
            .collect();
        if !outside.is_empty() {
            return Err(Refusal::new(
                "repair_depends_on_open_node",
                format!(
                    "The repair task {} waits on tasks that are not accepted ({}). A repair follows the failed \
                     task's accepted dependencies, or the failed task itself.",
                    node.id,
                    outside.join(", ")
                ),
            ));
        }
    }
    Ok(())
}

/// How many repair cycles a failed node has left.
pub fn cycles_left(run: &RunView, node_id: &str) -> u32 {
    let root = run
        .nodes
        .iter()
        .find(|node| node.id == node_id)
        .and_then(|node| node.repairs.clone())
        .unwrap_or_else(|| node_id.to_string());
    let taken = run
        .repairs
        .get(&root)
        .map(|groups| groups.len() as u32)
        .unwrap_or(0);
    MAX_REPAIR_CYCLES.saturating_sub(taken)
}

/// Whether the next cycle for a failed node is the re-plan.
pub fn next_cycle_is_replan(run: &RunView, node_id: &str) -> bool {
    let left = cycles_left(run, node_id);
    left > 0 && MAX_REPAIR_CYCLES - left + 1 >= REPLAN_CYCLE
}

// ---- the hard rejects ------------------------------------------------------------------------------------------------

/// The write-scope pairs two nodes may not have: neither ordered after the other, sharing a path.
///
/// Scopes are compared as paths (`topology::shared_scope_pairs` `as_paths`): `./src/x.py` is `src/x.py`, `src/` holds
/// it, and `src/*.py` matches it. `editable` limits the pairs to nodes that can still run (a finished or cancelled
/// node can never meet another); `involving` further limits them to pairs with one of those nodes in them — a repair
/// is checked against the run, not the run against itself again. `before` adds an order the record does not carry in
/// `depends_on`: a repair is ordered before every node that waits on the task it repairs.
pub fn write_scope_overlaps(
    nodes: &[GoalNode],
    editable: Option<&BTreeSet<String>>,
    involving: &BTreeSet<String>,
    before: Option<&BTreeMap<String, Vec<String>>>,
) -> Vec<String> {
    let mut parents = parents_of(nodes);
    if let Some(before) = before {
        for (node, extra) in before {
            let listed = parents.entry(node.clone()).or_default();
            for parent in extra {
                if !listed.contains(parent) {
                    listed.push(parent.clone());
                }
            }
        }
    }
    let scopes: Vec<(String, Vec<String>)> = nodes
        .iter()
        .map(|node| (node.id.clone(), node.write_scope.clone()))
        .collect();
    let mut out: Vec<String> = Vec::new();
    for pair in topology::shared_scope_pairs(&scopes, &parents, true) {
        if pair.joined || ordered(&pair.first, &pair.second, &parents) {
            continue;
        }
        if let Some(checked) = editable {
            if !checked.contains(&pair.first) || !checked.contains(&pair.second) {
                continue;
            }
        }
        if !involving.is_empty()
            && !involving.contains(&pair.first)
            && !involving.contains(&pair.second)
        {
            continue;
        }
        let side = |id: &str| {
            let scope = nodes
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| entry.write_scope.clone())
                .unwrap_or_default();
            pair.shared
                .iter()
                .filter(|entry| scope.contains(entry))
                .cloned()
                .collect::<Vec<String>>()
                .join(", ")
        };
        out.push(format!(
            "{} writes {} and {} writes {}",
            pair.first,
            side(&pair.first),
            pair.second,
            side(&pair.second)
        ));
    }
    out
}

/// The hard rejects over a whole graph: references, cycles, and write scopes shared without an order.
///
/// One refusal names every overlapping pair in the check, so a fix is not refused one pair per round. `editable`,
/// `involving` and `before` mean what they mean in [`write_scope_overlaps`].
pub fn require_graph(
    nodes: &[GoalNode],
    editable: Option<&BTreeSet<String>>,
    involving: &BTreeSet<String>,
    before: Option<&BTreeMap<String, Vec<String>>>,
) -> Result<(), Refusal> {
    if nodes.is_empty() {
        return Err(Refusal::new(
            "empty_graph",
            "A run needs at least one task.",
        ));
    }
    if nodes.len() > MAX_NODES {
        return Err(Refusal::new(
            "too_many_nodes",
            format!("A run holds at most {MAX_NODES} tasks; split the goal into phases."),
        ));
    }
    let mut ids: Vec<String> = Vec::new();
    for node in nodes {
        ids.push(node.id.clone());
    }
    if topology::unique(&ids).len() != ids.len() {
        return Err(Refusal::new(
            "duplicate_node_id",
            "Each task id must be unique in the run.",
        ));
    }
    let known: BTreeSet<String> = ids.iter().cloned().collect();
    for node in nodes {
        if let Some(problem) = topology::edge_problem(&node.id, &node.depends_on, &known) {
            let parent = problem.parent().to_string();
            let say = match problem {
                topology::EdgeProblem::UnknownDependency(_) => format!(
                    "Task {} depends on {parent}, which is not in the run.",
                    node.id
                ),
                topology::EdgeProblem::SelfDependency(_) => {
                    format!("Task {} cannot depend on itself.", node.id)
                }
            };
            return Err(Refusal::new(problem.reason(), say));
        }
    }
    let parents = parents_of(nodes);
    let (_, stuck) = topology::layer_of(&ids, &parents, false);
    if !stuck.is_empty() {
        return Err(Refusal::new(
            "dependency_cycle",
            format!(
                "These tasks depend on each other in a circle: {}.",
                stuck.join(", ")
            ),
        ));
    }
    let overlaps = write_scope_overlaps(nodes, editable, involving, before);
    if !overlaps.is_empty() {
        let named = overlaps
            .iter()
            .take(OVERLAPS_NAMED)
            .cloned()
            .collect::<Vec<String>>()
            .join("; ");
        let more = if overlaps.len() > OVERLAPS_NAMED {
            format!(" and {} more pairs", overlaps.len() - OVERLAPS_NAMED)
        } else {
            String::new()
        };
        return Err(Refusal::new(
            "write_scope_overlap",
            format!(
                "These tasks can run at the same time and write the same paths: {named}{more}. \
                 Make one of each pair depend on the other, or change the scope."
            ),
        ));
    }
    Ok(())
}

/// The verify node, when the graph has exactly one and it follows every producer.
///
/// A cancelled verify task is not one, so a replacement can be delegated; a verification's repair is not one either
/// (the verification it repairs runs again), so repairing it does not leave two.
pub fn require_verify_node(nodes: &[GoalNode]) -> Result<String, Refusal> {
    let verifiers: Vec<&GoalNode> = nodes
        .iter()
        .filter(|node| {
            role_of(node).is_verify() && !node.cancelled && !repairs_a_verification(nodes, node)
        })
        .collect();
    if verifiers.is_empty() {
        let producers = nodes.iter().filter(|node| is_producer(node)).count();
        return Err(Refusal::new(
            "no_verification_node",
            if producers == 0 {
                "A run needs exactly one verify task, and this plan has none.".to_string()
            } else {
                "A run needs exactly one verify task that checks the goal after every task that writes. This plan has none."
                    .to_string()
            },
        ));
    }
    if verifiers.len() > 1 {
        return Err(Refusal::new(
            "too_many_verify_nodes",
            format!(
                "A run has exactly one verify task; this plan has {}. Keep {}.",
                verifiers.len(),
                verifiers[0].id
            ),
        ));
    }
    let verify = verifiers[0];
    let missed = verification_misses(nodes, &[verify], &BTreeSet::new());
    if !missed.is_empty() {
        return Err(Refusal::new(
            "verify_misses_producers",
            format!(
                "The verify task {} must follow every task that writes; add it to the dependsOn of: {}.",
                verify.id,
                missed.join(", ")
            ),
        ));
    }
    Ok(verify.id.clone())
}

/// Whether the node is a verify task that writes nothing of its own.
pub fn check_verify_scope(nodes: &[GoalNode]) -> Result<(), Refusal> {
    if let Some(node) = nodes.iter().find(|node| role_of(node).is_verify()) {
        if node.write_scope.is_empty() {
            return Ok(());
        }
        if node.write_scope == vec![".".to_string()] {
            return Err(Refusal::new(
                "verify_writes_everything",
                format!(
                    "The verify task {} claims the whole checkout. A verify task checks the goal; give it the files it writes, or none.",
                    node.id
                ),
            ));
        }
    }
    Ok(())
}

/// Check one repair task before it joins the run: the task it repairs, the cycle cap, its dependencies, and the write
/// scopes it shares with everything that can still run.
///
/// The repaired root is not held against the repair: a repair writes what the task it repairs wrote. The nodes that
/// wait on the root are ordered after the repair ([`repair_order`]), so a repair may also share their scope. The rule
/// is the original's `_require_graph(..., editable=group | runnable, involving=group, before=below)` call.
pub fn check_repair(run: &RunView, repair: &GoalNode) -> Result<(), Refusal> {
    if run.nodes.iter().any(|node| node.id == repair.id) {
        return Err(Refusal::new(
            "duplicate_node_id",
            "Each task id must be unique in the run.",
        ));
    }
    let root_id = repair.repairs.clone().ok_or_else(|| {
        Refusal::new(
            "invalid_repair",
            "A repair task must name the failed task it repairs.",
        )
    })?;
    let root = run
        .nodes
        .iter()
        .find(|node| node.id == root_id)
        .ok_or_else(|| {
            Refusal::new(
                "unknown_repair_root",
                format!("There is no task {root_id} in this run to repair."),
            )
        })?;
    if root.cancelled {
        return Err(Refusal::new(
            "repair_of_cancelled",
            format!(
                "{root_id} was cancelled, so there is nothing to repair. Delegate a new task instead."
            ),
        ));
    }
    if !root.failed {
        return Err(Refusal::new(
            "repair_of_open_task",
            format!("Only a failed or blocked task is repaired; {root_id} is not one."),
        ));
    }
    let taken = run
        .repairs
        .get(&root_id)
        .map(|cycles| cycles.len() as u32)
        .unwrap_or(0);
    if taken >= MAX_REPAIR_CYCLES {
        return Err(Refusal::new(
            "repair_limit_reached",
            format!(
                "{root_id} has had {MAX_REPAIR_CYCLES} repair cycles. Report what is still open instead of repairing \
                 again, or delegate a new task for the rest."
            ),
        ));
    }
    // A verification's repair is a build task that fixes what it found; the verification then runs again
    // (`reruns_root`), so the repair never stands in for it and the run keeps one verifier.
    require_repair_edges(&[run.nodes.clone(), vec![repair.clone()]].concat())?;
    let mut nodes = run.nodes.clone();
    nodes.push(repair.clone());
    let mut editable = runnable(&run.nodes);
    editable.insert(repair.id.clone());
    let involving: BTreeSet<String> = [repair.id.clone()].into_iter().collect();
    let before = repair_order(run, &repair.id, &root_id);
    require_graph(&nodes, Some(&editable), &involving, Some(&before))
}

// ---- the run ---------------------------------------------------------------------------------------------------------

/// The nodes that can start now, in the run's order: not accepted, not dropped, every parent accepted, and any
/// irreversible approval already given by the person.
pub fn ready_nodes(run: &RunView) -> Vec<String> {
    let accepted: BTreeSet<String> = run
        .nodes
        .iter()
        .filter(|node| node.accepted || is_repaired(&run.nodes, &node.id))
        .map(|node| node.id.clone())
        .collect();
    let ids: Vec<String> = run.nodes.iter().map(|node| node.id.clone()).collect();
    let candidates: BTreeSet<String> = topology::ready(&ids, &parents_of(&run.nodes), &accepted)
        .into_iter()
        .collect();
    run.nodes
        .iter()
        .filter(|node| {
            candidates.contains(&node.id)
                && !node.accepted
                && !dropped(node)
                // A failed node waits for its repair — unless it is a verification whose repair group is accepted,
                // and then it is the one due to run again (`reruns_root`).
                && (!node.failed || rerun_due(run, node))
                && node.irreversible.as_ref().is_none_or(|step| step.answered)
        })
        .map(|node| node.id.clone())
        .collect()
}

/// The run's goal verdict, computed from the record: never from any agent's words.
///
/// `verified` only when every live task is accepted, every accepted task's gates passed, the verify task is accepted
/// with its handoff read, and the app's own run of the finish-line check passed. `failed` when a check or a gate
/// failed. Anything else is `unverified`, with a reason code per thing left undone.
pub fn goal_verdict(run: &RunView) -> (Verdict, Vec<String>) {
    // A repair's verification root is due to run again, and the record may still say it failed if the re-run hasn't
    // started yet; the re-run is the one thing standing between the run and done, so it is read as open, not failed.
    // Its superseded repairs are out, exactly as the original's `derive` marks older repair groups `superseded`.
    let live: Vec<&GoalNode> = run
        .nodes
        .iter()
        .enumerate()
        .filter(|(index, node)| !dropped(node) && !superseded(&run.nodes, *index))
        .map(|(_, node)| node)
        .collect();
    let mut reasons: Vec<String> = Vec::new();
    let failed = |reason: String| (Verdict::Failed, vec![reason]);

    // The app's own run of the finish line decides first: it is the goal.
    match run.latest.as_ref().map(|latest| latest.outcome) {
        Some(CheckOutcome::Failed) => return failed("check_failed".to_string()),
        Some(CheckOutcome::NotRun) => reasons.push("check_not_run".to_string()),
        None => reasons.push("check_not_run".to_string()),
        Some(CheckOutcome::Passed) => {}
    }

    // A gate that ran and failed fails the run. A gate that was held for the person, or was recorded as not run, is
    // not a pass and does not fail it either: the run is unverified and says which tasks nothing checked. No gate
    // outcome at all means no gate was configured for that task; `report` names those tasks as a finding so the
    // absence is said out loud, never silently counted as a pass.
    let gated: Vec<String> = live
        .iter()
        .filter(|node| node.accepted && gates_failed(node))
        .map(|node| node.id.clone())
        .collect();
    if !gated.is_empty() {
        return failed(format!("gate_failed:{}", gated.join(",")));
    }
    let ungated: Vec<String> = live
        .iter()
        .filter(|node| node.accepted && node.gate_outcome.is_some() && !gates_passed(node))
        .map(|node| node.id.clone())
        .collect();
    if !ungated.is_empty() {
        reasons.push(format!("gate_not_run:{}", ungated.join(",")));
    }

    // A failed verification whose repair group is accepted is not a failure any more: it is due to run again, exactly
    // as the original sets the root back to `pending` rather than `repaired`.
    let failed_nodes: Vec<String> = live
        .iter()
        .filter(|node| node.failed && !is_repaired(&run.nodes, &node.id) && !rerun_due(run, node))
        .map(|node| node.id.clone())
        .collect();
    if !failed_nodes.is_empty() {
        return failed(format!("task_failed:{}", failed_nodes.join(",")));
    }

    // A failed root an accepted repair stands in for counts as settled, exactly as the source's `repaired` state is
    // satisfied; only its repair node has to be accepted.
    let open: Vec<String> = live
        .iter()
        .filter(|node| !node.accepted && !is_repaired(&run.nodes, &node.id))
        .map(|node| node.id.clone())
        .collect();
    if !open.is_empty() {
        reasons.push(format!("tasks_open:{}", open.join(",")));
    }
    let parked: Vec<String> = live
        .iter()
        .filter(|node| {
            node.irreversible
                .as_ref()
                .is_some_and(|step| !step.answered)
        })
        .map(|node| node.id.clone())
        .collect();
    if !parked.is_empty() {
        reasons.push(format!("irreversible_unanswered:{}", parked.join(",")));
    }

    let verifiers: Vec<&GoalNode> = run
        .nodes
        .iter()
        .filter(|node| {
            !dropped(node) && role_of(node).is_verify() && !repairs_a_verification(&run.nodes, node)
        })
        .collect();
    let built = live.iter().any(|node| is_producer(node));
    if verifiers.is_empty() {
        reasons.push(
            if built {
                "no_verification_node"
            } else {
                "no_producers"
            }
            .to_string(),
        );
        return (Verdict::Unverified, reasons);
    }
    let passed: Vec<&GoalNode> = verifiers
        .iter()
        .copied()
        .filter(|node| node.accepted)
        .collect();
    let still: Vec<String> = verifiers
        .iter()
        .filter(|node| !node.accepted)
        .map(|node| node.id.clone())
        .collect();
    if !still.is_empty() {
        reasons.push(format!("verification_open:{}", still.join(",")));
    }
    let skipped: BTreeSet<String> = run
        .nodes
        .iter()
        .filter(|node| dropped(node))
        .map(|node| node.id.clone())
        .collect();
    let unreached = verification_misses(&run.nodes, &passed, &skipped);
    if !unreached.is_empty() {
        reasons.push(format!("verification_misses:{}", unreached.join(",")));
    }
    // An accepted task with no handoff the lead opened is not accepted for the goal, exactly as the original's
    // `handoff_not_checked` says.
    let unchecked: Vec<String> = passed
        .iter()
        .filter(|node| handoff_reason(node).is_some())
        .map(|node| {
            format!(
                "{}:{}",
                handoff_reason(node).unwrap_or("handoff_missing"),
                node.id
            )
        })
        .collect();
    if !unchecked.is_empty() {
        reasons.push(format!("handoff_not_checked:{}", unchecked.join(",")));
    }
    if run.latest.is_some() && reasons.is_empty() {
        return (Verdict::Verified, Vec::new());
    }
    if reasons.is_empty() {
        reasons.push("check_not_run".to_string());
    }
    (Verdict::Unverified, reasons)
}

/// Advisory findings: they never reject a run, and the run records them.
pub fn lint(nodes: &[GoalNode]) -> Vec<String> {
    let mut findings: Vec<String> = Vec::new();
    let parents = parents_of(nodes);
    let ids: Vec<String> = nodes.iter().map(|node| node.id.clone()).collect();
    if nodes.len() >= SERIAL_GRAPH_NODES {
        let chain = topology::critical_path(&ids, &parents).len();
        if chain as f64 >= SERIAL_GRAPH_SHARE * nodes.len() as f64 {
            findings.push(format!(
                "serial_graph:{} nodes, critical path {chain}; most of the graph is one chain, so split it into \
                 parallel lanes where the work allows.",
                nodes.len()
            ));
        }
        let layers = topology::layers(&ids, &parents).unwrap_or_default();
        if let Some(widest) = layers.iter().max_by_key(|layer| layer.len()) {
            if widest.len() > 4 {
                findings.push(format!(
                    "wide_layer:{} tasks can run at once, and at most 4 workers run together.",
                    widest.len()
                ));
            }
        }
    }
    let producers = nodes.iter().filter(|node| is_producer(node)).count();
    if producers == 0 && !nodes.is_empty() {
        findings.push("no_producers".to_string());
    }
    if let Some(node) = nodes
        .iter()
        .find(|node| node.irreversible.as_ref().is_some_and(|step| step.answered) && !node.accepted)
    {
        findings.push(format!("irreversible_approved_but_open:{}", node.id));
    }
    for node in nodes {
        if !dropped(node) {
            continue;
        }
        findings.push(format!("dropped:{}", node.id));
    }
    findings
}

/// Everything the rules answer about one run, in one call.
pub fn report(run: &RunView) -> GraphAnswer {
    let ids: Vec<String> = run.nodes.iter().map(|node| node.id.clone()).collect();
    let parents = parents_of(&run.nodes);
    // A finished node is never re-checked: its checkout is gone and its changes are integrated. Only what can still
    // run is held against the scopes, and a repair is ordered against the nodes waiting on the task it repairs.
    let editable = runnable(&run.nodes);
    let before = repair_orders(run);
    let refusal = require_graph(&run.nodes, Some(&editable), &BTreeSet::new(), Some(&before))
        .and_then(|()| require_repair_edges(&run.nodes))
        .and_then(|()| require_verify_node(&run.nodes))
        .and_then(|_| check_verify_scope(&run.nodes))
        .err();
    let (verdict, reasons) = if refusal.is_some() {
        (Verdict::Unverified, Vec::new())
    } else {
        goal_verdict(run)
    };
    let verify = run
        .nodes
        .iter()
        .find(|node| {
            role_of(node).is_verify()
                && !node.cancelled
                && !repairs_a_verification(&run.nodes, node)
        })
        .map(|node| node.id.clone());
    let cycles: BTreeMap<String, u32> = run
        .nodes
        .iter()
        .filter(|node| node.failed && !is_repaired(&run.nodes, &node.id))
        .map(|node| (node.id.clone(), cycles_left(run, &node.id)))
        .collect();
    let mut findings = lint(&run.nodes);
    // The tasks whose acceptance was never checked by a gate of the app's. The verdict cannot treat their absence as
    // a pass, so it says so where the card and the lead can read it.
    let no_gates: Vec<String> = run
        .nodes
        .iter()
        .filter(|node| !dropped(node) && node.accepted && node.gate_outcome.is_none())
        .map(|node| node.id.clone())
        .collect();
    if !no_gates.is_empty() {
        findings.push(format!("no_gates:{}", no_gates.join(",")));
    }
    if !run.goal.trim().is_empty() && run.baseline.is_none() {
        // The finish line was never proved to fail before the work started, so a green run proves less.
        findings.push("no_baseline".to_string());
    }
    GraphAnswer {
        refusal,
        report: Report {
            goal: run.goal.clone(),
            verdict,
            reasons,
            layers: topology::layers(&ids, &parents).unwrap_or_default(),
            critical_path: topology::critical_path(&ids, &parents),
            bottlenecks: topology::bottlenecks(&ids, &parents, topology::BOTTLENECK_LIMIT)
                .into_iter()
                .map(|(node, blocks)| Bottleneck { node, blocks })
                .collect(),
            lint: findings,
            ready: ready_nodes(run),
            cycles_left: cycles.clone(),
            replan: cycles
                .keys()
                .filter(|node| next_cycle_is_replan(run, node))
                .cloned()
                .collect(),
            extends_left: MAX_EXTEND_ROUNDS.saturating_sub(run.extends),
            verify,
        },
    }
}

#[cfg(test)]
mod tests {
    //! The cases the original keeps in `tests/test_dag_run_rules.py`, read onto Hivra's record.

    use super::*;
    use crate::goal_graph::{CheckRun, Handoff, Irreversible};

    fn node(id: &str) -> GoalNode {
        GoalNode {
            id: id.to_string(),
            title: id.to_string(),
            role: None,
            depends_on: Vec::new(),
            write_scope: vec!["src".to_string()],
            accepted: false,
            gate_outcome: None,
            failed: false,
            cancelled: false,
            handoff: None,
            repairs: None,
            irreversible: None,
        }
    }

    fn accepted(id: &str) -> GoalNode {
        GoalNode {
            accepted: true,
            gate_outcome: Some("passed".to_string()),
            handoff: Some(Handoff {
                path: format!("/worker/.hivra/handoff/{id}.md"),
                sha256: "0".repeat(64),
                bytes: 10,
                read: true,
            }),
            ..node(id)
        }
    }

    fn verify(id: &str, depends_on: &[&str]) -> GoalNode {
        GoalNode {
            role: Some(Role::Verify),
            write_scope: Vec::new(),
            depends_on: depends_on
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            ..node(id)
        }
    }

    fn green_check() -> Option<CheckRun> {
        Some(CheckRun {
            outcome: CheckOutcome::Passed,
            exit_code: Some(0),
            output: "exited 0 as expected".into(),
            layer: "app".into(),
            at: 1,
        })
    }

    fn run(nodes: Vec<GoalNode>) -> RunView {
        RunView {
            goal: "the check is green".into(),
            nodes,
            baseline: None,
            latest: green_check(),
            repairs: BTreeMap::new(),
            extends: 0,
        }
    }

    #[test]
    fn a_graph_refuses_unknown_and_self_edges_and_a_cycle() {
        let mut broken = node("a");
        broken.depends_on = vec!["ghost".into()];
        let refused = require_graph(&[broken], None, &BTreeSet::new(), None).unwrap_err();
        assert_eq!(refused.reason, "unknown_dependency");

        let mut itself = node("a");
        itself.depends_on = vec!["a".into()];
        assert_eq!(
            require_graph(&[itself], None, &BTreeSet::new(), None)
                .unwrap_err()
                .reason,
            "self_dependency"
        );

        let first = {
            let mut entry = node("a");
            entry.depends_on = vec!["b".into()];
            entry
        };
        let second = {
            let mut entry = node("b");
            entry.depends_on = vec!["a".into()];
            entry
        };
        let refused = require_graph(&[first, second], None, &BTreeSet::new(), None).unwrap_err();
        assert_eq!(refused.reason, "dependency_cycle");
        assert!(refused.message().contains("a, b"));

        let one = node("a");
        assert_eq!(
            require_graph(&[one.clone(), one], None, &BTreeSet::new(), None)
                .unwrap_err()
                .reason,
            "duplicate_node_id"
        );
        assert!(require_graph(&[], None, &BTreeSet::new(), None).is_err());
    }

    #[test]
    fn two_tasks_that_can_run_at_once_may_not_share_a_scope() {
        let mut first = node("a");
        first.write_scope = vec!["src/".into()];
        let mut second = node("b");
        second.write_scope = vec!["./src/x.py".into()];
        let refused = require_graph(
            &[first.clone(), second.clone()],
            None,
            &BTreeSet::new(),
            None,
        )
        .unwrap_err();
        assert_eq!(refused.reason, "write_scope_overlap");
        assert!(refused.message().contains("src"));
        assert!(refused
            .message()
            .contains("Make one of each pair depend on the other"));

        // Adding a dependency fixes it.
        let mut ordered_second = second.clone();
        ordered_second.depends_on = vec!["a".into()];
        require_graph(
            &[first.clone(), ordered_second],
            None,
            &BTreeSet::new(),
            None,
        )
        .unwrap();

        // And so does an order through a third node: they never run at the same time.
        let mut middle = node("m");
        middle.write_scope = vec!["docs".into()];
        let mut last = second.clone();
        last.depends_on = vec!["m".into()];
        let mut first_two = first.clone();
        first_two.depends_on = Vec::new();
        let mut bridge = middle.clone();
        bridge.depends_on = vec!["a".into()];
        require_graph(&[first_two, bridge, last], None, &BTreeSet::new(), None).unwrap();
    }

    #[test]
    fn one_refusal_names_every_pair_not_one_per_round() {
        let mut nodes: Vec<GoalNode> = Vec::new();
        for index in 0..3 {
            let mut entry = node(&format!("n{index}"));
            entry.write_scope = vec!["src/shared.rs".into()];
            nodes.push(entry);
        }
        let refused = require_graph(&nodes, None, &BTreeSet::new(), None).unwrap_err();
        assert_eq!(refused.reason, "write_scope_overlap");
        assert!(refused.message().contains("n0 writes src/shared.rs"));
        assert!(refused.message().contains("n1 writes src/shared.rs"));
        assert!(refused.message().contains("n2 writes src/shared.rs"));
    }

    #[test]
    fn a_repair_is_checked_against_the_run_not_against_the_node_it_repairs() {
        let mut root = node("a");
        root.write_scope = vec!["src/a.rs".into()];
        root.failed = true;
        let mut below = node("b");
        below.depends_on = vec!["a".into()];
        below.write_scope = vec!["src/b.rs".into()];
        let mut elsewhere = node("c");
        elsewhere.write_scope = vec!["docs/c.md".into()];
        let record = run(vec![root, below, elsewhere]);

        // The repair writes what its failed root wrote: the root is not held against it.
        let mut repair = node("r");
        repair.repairs = Some("a".into());
        repair.write_scope = vec!["src/a.rs".into()];
        check_repair(&record, &repair).unwrap();

        // It may share a path with a node that waits on the root: that node waits for the repair.
        repair.write_scope = vec!["src/b.rs".into()];
        check_repair(&record, &repair).unwrap();

        // But not with a task it can run beside.
        repair.write_scope = vec!["docs/c.md".into()];
        let refused = check_repair(&record, &repair).unwrap_err();
        assert_eq!(refused.reason, "write_scope_overlap");
        assert!(refused.message().contains("r writes docs/c.md"));
        assert!(refused.message().contains("c writes docs/c.md"));
    }

    #[test]
    fn a_run_needs_exactly_one_verify_task_that_follows_every_producer() {
        let producer = node("a");
        let refused = require_verify_node(std::slice::from_ref(&producer)).unwrap_err();
        assert_eq!(refused.reason, "no_verification_node");

        let two = vec![producer.clone(), verify("v1", &["a"]), verify("v2", &["a"])];
        assert_eq!(
            require_verify_node(&two).unwrap_err().reason,
            "too_many_verify_nodes"
        );

        let missing = vec![producer.clone(), verify("v", &[])];
        let refused = require_verify_node(&missing).unwrap_err();
        assert_eq!(refused.reason, "verify_misses_producers");
        assert!(refused.message().contains("a"));

        require_verify_node(&[producer, verify("v", &["a"])]).unwrap();
    }

    #[test]
    fn a_verify_task_that_claims_the_whole_checkout_is_refused() {
        let mut writer = node("a");
        writer.write_scope = vec!["src".into()];
        let mut wide = verify("v", &["a"]);
        wide.write_scope = vec![".".into()];
        let refused = check_verify_scope(&[writer.clone(), wide]).unwrap_err();
        assert_eq!(refused.reason, "verify_writes_everything");
        let mut narrow = verify("v", &["a"]);
        narrow.write_scope = vec!["docs/report.md".into()];
        check_verify_scope(&[writer, narrow]).unwrap();
    }

    #[test]
    fn a_verified_run_needs_every_task_accepted_the_verify_read_and_the_check_green() {
        let good = run(vec![accepted("a"), {
            let mut node = verify("v", &["a"]);
            node.accepted = true;
            node.gate_outcome = Some("passed".to_string());
            node.handoff = Some(Handoff {
                path: "/w/.hivra/handoff/v.md".into(),
                sha256: "0".repeat(64),
                bytes: 1,
                read: true,
            });
            node
        }]);
        assert_eq!(goal_verdict(&good), (Verdict::Verified, Vec::new()));
    }

    #[test]
    fn each_thing_left_undone_gets_its_own_reason() {
        // The verify task is still open.
        let open_verify = run(vec![accepted("a"), verify("v", &["a"])]);
        let (verdict, reasons) = goal_verdict(&open_verify);
        assert_eq!(verdict, Verdict::Unverified);
        assert!(reasons.contains(&"tasks_open:v".to_string()), "{reasons:?}");
        assert!(
            reasons
                .iter()
                .any(|reason| reason.starts_with("verification_open:")),
            "{reasons:?}"
        );

        // Its handoff was never opened.
        let mut unread = verify("v", &["a"]);
        unread.accepted = true;
        unread.gate_outcome = Some("passed".to_string());
        unread.handoff = Some(Handoff {
            path: "/w/.hivra/handoff/v.md".into(),
            sha256: "0".repeat(64),
            bytes: 1,
            read: false,
        });
        let (verdict, reasons) = goal_verdict(&run(vec![accepted("a"), unread]));
        assert_eq!(verdict, Verdict::Unverified);
        assert!(
            reasons
                .iter()
                .any(|reason| reason.starts_with("handoff_not_checked:")),
            "{reasons:?}"
        );

        // No handoff file at all.
        let mut absent = verify("v", &["a"]);
        absent.accepted = true;
        absent.gate_outcome = Some("passed".to_string());
        let (verdict, reasons) = goal_verdict(&run(vec![accepted("a"), absent]));
        assert_eq!(verdict, Verdict::Unverified);
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("handoff_missing:v")),
            "{reasons:?}"
        );

        // A gate failed on an accepted task.
        let mut gated = accepted("a");
        gated.gate_outcome = Some("failed".to_string());
        let checker = accepted_verify("v", &["a"]);
        let (verdict, reasons) = goal_verdict(&run(vec![gated, checker.clone()]));
        assert_eq!(verdict, Verdict::Failed);
        assert_eq!(reasons, vec!["gate_failed:a".to_string()]);

        // A gate that was held for the person, or was not run, is not a pass: the run says which task nothing
        // checked, and never says Verified.
        for outcome in ["held", "notRun"] {
            let mut ungated = accepted("a");
            ungated.gate_outcome = Some(outcome.to_string());
            let (verdict, reasons) = goal_verdict(&run(vec![ungated, checker.clone()]));
            assert_eq!(verdict, Verdict::Unverified, "{outcome}");
            assert!(
                reasons.contains(&"gate_not_run:a".to_string()),
                "{outcome}: {reasons:?}"
            );
        }

        // The app's own run of the check is red.
        let mut red = run(vec![accepted("a"), {
            let mut node = verify("v", &["a"]);
            node.accepted = true;
            node.gate_outcome = Some("passed".to_string());
            node.handoff = Some(Handoff {
                path: "/w/.hivra/handoff/v.md".into(),
                sha256: "0".repeat(64),
                bytes: 1,
                read: true,
            });
            node
        }]);
        red.latest = Some(CheckRun {
            outcome: CheckOutcome::Failed,
            exit_code: Some(1),
            output: "1 failing".into(),
            layer: "app".into(),
            at: 2,
        });
        assert_eq!(goal_verdict(&red).0, Verdict::Failed);

        // The check has not run.
        let mut unrun = red.clone();
        unrun.latest = None;
        let (verdict, reasons) = goal_verdict(&unrun);
        assert_eq!(verdict, Verdict::Unverified);
        assert!(reasons.contains(&"check_not_run".to_string()));
        let mut timed_out = red;
        timed_out.latest = Some(CheckRun {
            outcome: CheckOutcome::NotRun,
            exit_code: None,
            output: "did not finish before its timeout".into(),
            layer: "app".into(),
            at: 3,
        });
        let (verdict, reasons) = goal_verdict(&timed_out);
        assert_eq!(verdict, Verdict::Unverified);
        assert!(reasons.contains(&"check_not_run".to_string()));
    }

    #[test]
    fn a_baseline_failure_that_stays_failing_is_not_green() {
        let mut run = run(vec![accepted("a"), {
            let mut node = verify("v", &["a"]);
            node.accepted = true;
            node.gate_outcome = Some("passed".to_string());
            node.handoff = Some(Handoff {
                path: "/w/.hivra/handoff/v.md".into(),
                sha256: "0".repeat(64),
                bytes: 1,
                read: true,
            });
            node
        }]);
        run.baseline = Some(CheckRun {
            outcome: CheckOutcome::Failed,
            exit_code: Some(1),
            output: "1 failing".into(),
            layer: "app".into(),
            at: 0,
        });
        assert_eq!(goal_verdict(&run).0, Verdict::Verified);
        // Still failing at the end: not green, whatever the baseline said.
        run.latest = Some(CheckRun {
            outcome: CheckOutcome::Failed,
            exit_code: Some(1),
            output: "1 failing".into(),
            layer: "app".into(),
            at: 9,
        });
        assert_eq!(goal_verdict(&run).0, Verdict::Failed);
    }

    #[test]
    fn a_task_whose_gate_failed_keeps_the_report_from_saying_verified() {
        // Through `report()`, the path the card and `finish` read: a failed WP-40 gate is the run's own failure.
        let mut gated = accepted("a");
        gated.gate_outcome = Some("failed".to_string());
        let answer = report(&run(vec![gated, accepted_verify("v", &["a"])]));
        assert!(answer.refusal.is_none(), "{:?}", answer.refusal);
        assert_eq!(answer.report.verdict, Verdict::Failed);
        assert_eq!(answer.report.reasons, vec!["gate_failed:a".to_string()]);

        // A gate that was held or never ran is not a pass.
        for outcome in ["held", "notRun"] {
            let mut ungated = accepted("a");
            ungated.gate_outcome = Some(outcome.to_string());
            let answer = report(&run(vec![ungated, accepted_verify("v", &["a"])]));
            assert!(answer.refusal.is_none(), "{:?}", answer.refusal);
            assert_eq!(answer.report.verdict, Verdict::Unverified, "{outcome}");
            assert_eq!(answer.report.reasons, vec!["gate_not_run:a".to_string()]);
        }

        // A task with no gate configured says so, and the card must not read as if a gate had passed.
        let mut ungated = accepted("a");
        ungated.gate_outcome = None;
        let answer = report(&run(vec![ungated, accepted_verify("v", &["a"])]));
        assert!(answer.refusal.is_none(), "{:?}", answer.refusal);
        assert!(
            answer.report.lint.contains(&"no_gates:a".to_string()),
            "{:?}",
            answer.report.lint
        );
    }

    #[test]
    fn a_producer_no_verify_task_follows_is_named() {
        let mut second = accepted("b");
        second.depends_on = Vec::new();
        let nodes = vec![accepted("a"), second, {
            let mut node = verify("v", &["a"]);
            node.accepted = true;
            node.gate_outcome = Some("passed".to_string());
            node.handoff = Some(Handoff {
                path: "/w/.hivra/handoff/v.md".into(),
                sha256: "0".repeat(64),
                bytes: 1,
                read: true,
            });
            node
        }];
        let (verdict, reasons) = goal_verdict(&run(nodes));
        assert_eq!(verdict, Verdict::Unverified);
        assert!(
            reasons.contains(&"verification_misses:b".to_string()),
            "{reasons:?}"
        );
    }

    fn accepted_verify(id: &str, depends_on: &[&str]) -> GoalNode {
        let mut node = verify(id, depends_on);
        node.accepted = true;
        node.gate_outcome = Some("passed".to_string());
        node.handoff = Some(Handoff {
            path: format!("/w/.hivra/handoff/{id}.md"),
            sha256: "0".repeat(64),
            bytes: 1,
            read: true,
        });
        node
    }

    #[test]
    fn a_failed_task_whose_repair_writes_the_same_file_leaves_a_run_that_finishes() {
        // The reported failure: a task writing src/a.rs fails, the repair writes the same file. Before `check_repair`
        // and `report`'s editable set this was refused as an overlap forever, so `finish` could never pass.
        let mut broken = node("a");
        broken.write_scope = vec!["src/a.rs".into()];
        broken.failed = true;
        let mut repair = node("r");
        repair.write_scope = vec!["src/a.rs".into()];
        repair.repairs = Some("a".into());
        // The repair is offered to the run and accepted by the rules before anything accepts it.
        let mut record = run(vec![broken.clone(), accepted_verify("v", &["a", "r"])]);
        check_repair(&record, &repair).unwrap();
        assert!(ready_nodes(&run(vec![broken.clone(), repair.clone()])).contains(&"r".to_string()));

        let mut fixed = accepted("r");
        fixed.write_scope = repair.write_scope;
        fixed.repairs = repair.repairs;
        record.nodes.insert(1, fixed);
        record.repairs.insert("a".into(), vec![vec!["r".into()]]);
        let answer = report(&record);
        assert!(answer.refusal.is_none(), "{:?}", answer.refusal);
        assert_eq!(
            answer.report.verdict,
            Verdict::Verified,
            "{:?}",
            answer.report.reasons
        );

        // Dropping the failed root instead of accepting the repair leaves the run finishable too.
        record.nodes[0].cancelled = true;
        let answer = report(&record);
        assert!(answer.refusal.is_none(), "{:?}", answer.refusal);
        assert_eq!(
            answer.report.verdict,
            Verdict::Verified,
            "{:?}",
            answer.report.reasons
        );
    }

    #[test]
    fn a_cancelled_task_cannot_be_repaired() {
        let mut gone = node("a");
        gone.cancelled = true;
        let record = run(vec![gone]);
        let mut repair = node("r");
        repair.repairs = Some("a".into());
        let refused = check_repair(&record, &repair).unwrap_err();
        assert_eq!(refused.reason, "repair_of_cancelled");
        assert!(refused.message().contains("Delegate a new task instead"));
    }

    #[test]
    fn a_repair_may_depend_only_on_accepted_tasks_or_the_failed_task_it_repairs() {
        let mut broken = node("a");
        broken.failed = true;
        let mut still_open = node("b");
        still_open.write_scope = vec!["docs/b.md".into()];
        let record = run(vec![broken.clone(), still_open]);

        let mut repair = node("r");
        repair.repairs = Some("a".into());
        repair.depends_on = vec!["b".into()];
        let refused = check_repair(&record, &repair).unwrap_err();
        assert_eq!(refused.reason, "repair_depends_on_open_node");
        assert!(refused.message().contains("b"));

        // The failed task itself, and an accepted task, are both allowed.
        let mut accepted_parent = accepted("c");
        accepted_parent.write_scope = vec!["docs/c.md".into()];
        let record = run(vec![broken, accepted_parent]);
        repair.depends_on = vec!["a".into(), "c".into()];
        repair.write_scope = vec!["src/a.rs".into()];
        check_repair(&record, &repair).unwrap();
    }

    #[test]
    fn a_repaired_verification_runs_again_before_the_run_is_done() {
        // The original's `reruns_root` (dag_run.py:1490-1491, `test_a_repaired_verification_runs_again_before_the_run_is_done`):
        // a repair of a verification fixes what it found, and only the verification running again says the goal holds.
        // Through `report()`, the path the card and `finish` read.
        let build = accepted("a");
        let mut failed_verify = verify("v", &["a"]);
        failed_verify.failed = true;
        let mut record = run(vec![build.clone(), failed_verify.clone()]);

        // The repair of a verification is a build task that fixes what it found: a build repair is accepted by the
        // rules, and the verification it repairs runs again. It stands in for the verification's coverage while the
        // verification is due to re-run, exactly as the original's `verification_misses` states.
        let mut again = node("v2");
        again.repairs = Some("v".into());
        again.depends_on = vec!["a".into()];
        again.write_scope = vec!["src/a.rs".into()];
        check_repair(&record, &again).unwrap();

        // Until the repair is accepted the failed verification shows and the run is not done.
        record.repairs.insert("v".into(), vec![vec!["v2".into()]]);
        record.nodes.push(again.clone());
        let open = report(&record);
        assert!(open.refusal.is_none(), "{:?}", open.refusal);
        assert_eq!(open.report.verdict, Verdict::Failed);
        assert_eq!(open.report.reasons, vec!["task_failed:v".to_string()]);

        // Accepting the repair does not settle the verification: a verification is never `repaired`, it runs again,
        // and the run still has exactly one verifier — the failed task itself.
        let mut accepted_again = accepted("v2");
        accepted_again.write_scope = vec!["src/a.rs".into()];
        accepted_again.repairs = Some("v".into());
        record.nodes[2] = accepted_again;
        let waiting = report(&record);
        assert!(waiting.refusal.is_none(), "{:?}", waiting.refusal);
        assert_eq!(waiting.report.verify.as_deref(), Some("v"));
        assert_eq!(waiting.report.verdict, Verdict::Unverified);
        assert!(
            waiting
                .report
                .reasons
                .contains(&"verification_open:v".to_string()),
            "{:?}",
            waiting.report.reasons
        );

        // The orchestrator puts it back in the queue; the run reads the same and the task is ready to run again.
        record.nodes[1].failed = false;
        let queued = report(&record);
        assert!(queued.refusal.is_none(), "{:?}", queued.refusal);
        assert_eq!(queued.report.verdict, Verdict::Unverified);
        assert_eq!(queued.report.reasons, waiting.report.reasons);
        assert!(ready_nodes(&run(record.nodes.clone())).contains(&"v".to_string()));

        // The verification runs again and passes: now the run is done.
        record.nodes[1] = accepted_verify("v", &["a"]);
        let answer = report(&record);
        assert!(answer.refusal.is_none(), "{:?}", answer.refusal);
        assert_eq!(answer.report.verify.as_deref(), Some("v"));
        assert_eq!(
            answer.report.verdict,
            Verdict::Verified,
            "{:?}",
            answer.report.reasons
        );
    }

    #[test]
    fn a_second_failed_verification_takes_the_last_cycle_and_a_third_is_refused() {
        // The original's `test_a_failed_reverification_takes_the_second_cycle_then_the_run_stops`: each repair of the
        // verification fixes what it found, the verification runs again, and its second failure is the last cycle.
        let mut failed_verify = verify("v", &["a"]);
        failed_verify.failed = true;
        let mut record = run(vec![accepted("a"), failed_verify]);
        record.repairs.insert("v".into(), vec![vec!["v2".into()]]);

        // One cycle left, and the next repair is the re-plan.
        let mut v2 = node("v2");
        v2.repairs = Some("v".into());
        v2.write_scope = vec!["src/a.rs".into()];
        v2.failed = true;
        record.nodes.push(v2);
        let mut v3 = node("v3");
        v3.repairs = Some("v".into());
        v3.write_scope = vec!["src/a.rs".into()];
        check_repair(&record, &v3).unwrap();
        assert!(next_cycle_is_replan(&record, "v"));

        // A verification whose first repair is accepted, whose re-run fails, and whose second repair is accepted, is
        // still open: the run has used both cycles and says so instead of repairing again.
        record
            .repairs
            .insert("v".into(), vec![vec!["v2".into()], vec!["v3".into()]]);
        let mut accepted_second = accepted("v3");
        accepted_second.write_scope = vec!["src/a.rs".into()];
        accepted_second.repairs = Some("v".into());
        record.nodes[2] = accepted("v2");
        record.nodes[2].write_scope = vec!["src/a.rs".into()];
        record.nodes[2].repairs = Some("v".into());
        record.nodes[2].accepted = true;
        record.nodes.push(accepted_second);
        // Both groups accepted and the record still says the verification failed: it is due to run again, so the run
        // is open rather than failed, and no cycle is left to repair a third failure.
        let stopped = report(&record);
        assert!(stopped.refusal.is_none(), "{:?}", stopped.refusal);
        assert_eq!(stopped.report.verdict, Verdict::Unverified);
        assert!(
            stopped
                .report
                .reasons
                .contains(&"verification_open:v".to_string()),
            "{:?}",
            stopped.report.reasons
        );
        assert_eq!(stopped.report.cycles_left.get("v"), Some(&0));

        // The re-run fails: with no cycle left, the run is failed and says which task.
        record.nodes[1].failed = true;
        record.repairs.remove("v");
        let failed = report(&record);
        assert!(failed.refusal.is_none(), "{:?}", failed.refusal);
        assert_eq!(failed.report.verdict, Verdict::Failed);
        assert_eq!(failed.report.reasons, vec!["task_failed:v".to_string()]);
        record
            .repairs
            .insert("v".into(), vec![vec!["v2".into()], vec!["v3".into()]]);

        let mut v4 = node("v4");
        v4.repairs = Some("v".into());
        v4.write_scope = vec!["src/a.rs".into()];
        assert_eq!(
            check_repair(&record, &v4).unwrap_err().reason,
            "repair_limit_reached"
        );
    }

    #[test]
    fn a_cancelled_verify_task_can_be_replaced_by_another_verify_task() {
        let mut gone = verify("v", &["a"]);
        gone.cancelled = true;
        let mut fresh = accepted_verify("v2", &["a"]);
        fresh.role = Some(Role::Verify);
        assert_eq!(
            require_verify_node(&[accepted("a"), gone, fresh]).unwrap(),
            "v2"
        );
    }

    #[test]
    fn two_repair_cycles_are_allowed_and_the_second_is_the_replan() {
        let mut record = run(vec![{
            let mut broken = node("a");
            broken.failed = true;
            broken
        }]);
        assert_eq!(cycles_left(&record, "a"), 2);
        assert!(!next_cycle_is_replan(&record, "a"));
        record.repairs.insert("a".into(), vec![vec!["r1".into()]]);
        assert_eq!(cycles_left(&record, "a"), 1);
        assert!(next_cycle_is_replan(&record, "a"));
        record
            .repairs
            .insert("a".into(), vec![vec!["r1".into()], vec!["r2".into()]]);
        assert_eq!(cycles_left(&record, "a"), 0);
        assert!(!next_cycle_is_replan(&record, "a"));
        // A repair node is measured against its own root, not itself.
        let mut repair = node("r1");
        repair.repairs = Some("a".into());
        repair.failed = true;
        record.nodes.push(repair);
        assert_eq!(cycles_left(&record, "r1"), 0);
    }

    #[test]
    fn only_the_failed_tasks_downstream_waits() {
        let mut broken = node("a");
        broken.failed = true;
        let mut downstream = node("b");
        downstream.depends_on = vec!["a".into()];
        let mut independent = node("c");
        independent.write_scope = vec!["docs".into()];
        let record = run(vec![broken, downstream, independent]);
        assert_eq!(ready_nodes(&record), vec!["c".to_string()]);
    }

    #[test]
    fn a_task_whose_irreversible_step_is_unanswered_does_not_start() {
        let mut parked = node("a");
        parked.irreversible = Some(Irreversible {
            reason: "it migrates the shared database".into(),
            key: "irreversible/run/a".into(),
            answered: false,
        });
        let mut plain = node("b");
        plain.write_scope = vec!["docs".into()];
        let record = run(vec![parked.clone(), plain.clone()]);
        assert_eq!(ready_nodes(&record), vec!["b".to_string()]);
        let (verdict, reasons) = goal_verdict(&record);
        assert_eq!(verdict, Verdict::Unverified);
        assert!(
            reasons.contains(&"irreversible_unanswered:a".to_string()),
            "{reasons:?}"
        );
        // The person approved it: it can start.
        parked.irreversible = Some(Irreversible {
            reason: "it migrates the shared database".into(),
            key: "irreversible/run/a".into(),
            answered: true,
        });
        assert_eq!(
            ready_nodes(&run(vec![parked, plain])),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn an_ordinary_task_is_not_parked() {
        let record = run(vec![node("a"), node("b")]);
        assert_eq!(ready_nodes(&record), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn a_dropped_task_is_not_part_of_the_goal() {
        let mut gone = node("a");
        gone.cancelled = true;
        let mut checker = verify("v", &[]);
        checker.accepted = true;
        checker.gate_outcome = Some("passed".to_string());
        checker.handoff = Some(Handoff {
            path: "/w/.hivra/handoff/v.md".into(),
            sha256: "0".repeat(64),
            bytes: 1,
            read: true,
        });
        let record = run(vec![gone, checker]);
        assert_eq!(goal_verdict(&record).0, Verdict::Verified);
        assert!(lint(&record.nodes).contains(&"dropped:a".to_string()));
    }

    #[test]
    fn the_report_answers_the_layers_the_path_and_the_verify_node() {
        let mut first = node("a");
        first.write_scope = vec!["src".into()];
        let mut second = node("b");
        second.depends_on = vec!["a".into()];
        second.write_scope = vec!["src/b.rs".into()];
        let mut checker = verify("v", &["a", "b"]);
        checker.write_scope = Vec::new();
        let answer = report(&run(vec![first, second, checker]));
        assert!(answer.refusal.is_none(), "{:?}", answer.refusal);
        assert_eq!(
            answer.report.layers,
            vec![
                vec!["a".to_string()],
                vec!["b".to_string()],
                vec!["v".to_string()]
            ]
        );
        assert_eq!(answer.report.critical_path, vec!["a", "b", "v"]);
        assert_eq!(answer.report.verify.as_deref(), Some("v"));
        assert_eq!(
            answer
                .report
                .bottlenecks
                .first()
                .map(|entry| entry.node.as_str()),
            Some("a")
        );
    }

    #[test]
    fn the_report_refuses_a_plan_with_no_verify_task_and_says_nothing_else() {
        let answer = report(&run(vec![node("a")]));
        let refusal = answer.refusal.unwrap();
        assert_eq!(refusal.reason, "no_verification_node");
        assert_eq!(answer.report.verdict, Verdict::Unverified);
        assert!(answer.report.reasons.is_empty());
    }

    #[test]
    fn lint_is_advisory_and_never_rejects() {
        let mut nodes: Vec<GoalNode> = (0..6)
            .map(|index| {
                let mut entry = node(&format!("n{index}"));
                entry.write_scope = vec![format!("src/{index}")];
                if index > 0 {
                    entry.depends_on = vec![format!("n{}", index - 1)];
                }
                entry
            })
            .collect();
        nodes.push(verify("v", &["n0", "n1", "n2", "n3", "n4", "n5"]));
        let findings = lint(&nodes);
        assert!(
            findings
                .iter()
                .any(|finding| finding.starts_with("serial_graph:")),
            "{findings:?}"
        );
        // Advisory: the graph itself still holds.
        require_graph(&nodes, None, &BTreeSet::new(), None).unwrap();
    }
}
