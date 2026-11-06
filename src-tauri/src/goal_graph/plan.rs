// WP-91: the graph is checked when the plan is approved. `validateProposedTasks` (orchestrationPlan.ts) has already
// normalised every `files` entry to a project-relative path — there is one scope normaliser, not two — so this only
// decides the graph: references, a cycle, two tasks that can run at the same time sharing a write scope, and the one
// verify task that has to follow every task that writes.
//
// The dispatch-time overlap check in `pump` stays as the second guard, because `delegate` can add tasks after the
// plan is approved.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::record;
use super::topology;
use super::{Bottleneck, GoalNode, Refusal, Role};

/// One task of a proposal, as the graph rules read it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedNode {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub role: Option<Role>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// The proposal's `files`, already project-relative and normalised by the webview.
    #[serde(default)]
    pub write_scope: Vec<String>,
}

/// What the graph check answers about a plan that holds.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAnswer {
    /// The one verify task's id.
    pub verify: String,
    pub layers: Vec<Vec<String>>,
    pub critical_path: Vec<String>,
    pub bottlenecks: Vec<Bottleneck>,
    /// Advisory findings; they never reject a plan.
    pub lint: Vec<String>,
}

/// A proposal's tasks as the run's nodes, before any of them runs.
pub fn to_nodes(proposed: &[ProposedNode]) -> Vec<GoalNode> {
    proposed
        .iter()
        .map(|task| GoalNode {
            id: task.id.clone(),
            title: task.title.clone(),
            role: task.role,
            depends_on: task.depends_on.clone(),
            write_scope: task.write_scope.clone(),
            accepted: false,
            gate_outcome: None,
            failed: false,
            cancelled: false,
            handoff: None,
            repairs: None,
            irreversible: None,
        })
        .collect()
}

/// The hard rejects over a plan, and what holds when none fires.
pub fn check_plan(proposed: Vec<ProposedNode>) -> Result<PlanAnswer, Refusal> {
    if proposed.is_empty() {
        return Err(Refusal::new(
            "empty_graph",
            "A plan needs at least one task.",
        ));
    }
    // A task that is not the verify task has to say what it may write.
    for task in &proposed {
        if !task.role.unwrap_or_default().is_verify() && task.write_scope.is_empty() {
            return Err(Refusal::new(
                "no_write_scope",
                format!(
                    "Task {} has no file scope. Give it project-relative paths, or '.' for the whole project.",
                    task.id
                ),
            ));
        }
    }
    let nodes = to_nodes(&proposed);
    record::require_graph(&nodes, None, &BTreeSet::new(), None)?;
    let verify = record::require_verify_node(&nodes)?;
    record::check_verify_scope(&nodes)?;
    let ids: Vec<String> = nodes.iter().map(|node| node.id.clone()).collect();
    let parents = record::parents_of(&nodes);
    Ok(PlanAnswer {
        verify,
        layers: topology::layers(&ids, &parents).unwrap_or_default(),
        critical_path: topology::critical_path(&ids, &parents),
        bottlenecks: topology::bottlenecks(&ids, &parents, topology::BOTTLENECK_LIMIT)
            .into_iter()
            .map(|(node, blocks)| Bottleneck { node, blocks })
            .collect(),
        lint: record::lint(&nodes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, files: &[&str], depends_on: &[&str]) -> ProposedNode {
        ProposedNode {
            id: id.to_string(),
            title: id.to_string(),
            role: None,
            depends_on: depends_on
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            write_scope: files.iter().map(|value| (*value).to_string()).collect(),
        }
    }

    fn checker(depends_on: &[&str]) -> ProposedNode {
        ProposedNode {
            id: "verify".to_string(),
            title: "Check the goal".to_string(),
            role: Some(Role::Verify),
            depends_on: depends_on
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            write_scope: Vec::new(),
        }
    }

    #[test]
    fn a_plan_with_two_concurrent_tasks_sharing_a_scope_is_refused_and_names_the_pairs() {
        let plan = vec![
            task("a", &["src/api"], &[]),
            task("b", &["./src/api/users.ts"], &[]),
            checker(&["a", "b"]),
        ];
        let refused = check_plan(plan).unwrap_err();
        assert_eq!(refused.reason, "write_scope_overlap");
        assert!(refused.message().contains("a writes src/api"));
        assert!(refused.message().contains("b writes ./src/api/users.ts"));
        assert!(refused
            .message()
            .contains("Make one of each pair depend on the other"));
    }

    #[test]
    fn adding_a_dependency_fixes_the_same_plan() {
        let plan = vec![
            task("a", &["src/api"], &[]),
            task("b", &["src/api/users.ts"], &["a"]),
            checker(&["a", "b"]),
        ];
        let answer = check_plan(plan).unwrap();
        assert_eq!(answer.verify, "verify");
        assert_eq!(
            answer.layers,
            vec![
                vec!["a".to_string()],
                vec!["b".to_string()],
                vec!["verify".to_string()]
            ]
        );
    }

    #[test]
    fn two_verify_tasks_a_missing_one_and_a_producer_it_does_not_follow_are_all_refused() {
        let two = vec![
            task("a", &["src"], &[]),
            checker(&["a"]),
            ProposedNode {
                id: "verify-2".into(),
                ..checker(&["a"])
            },
        ];
        assert_eq!(check_plan(two).unwrap_err().reason, "too_many_verify_nodes");

        let missing = vec![task("a", &["src"], &[])];
        assert_eq!(
            check_plan(missing).unwrap_err().reason,
            "no_verification_node"
        );

        let unfollowed = vec![task("a", &["src"], &[]), checker(&[])];
        let refused = check_plan(unfollowed).unwrap_err();
        assert_eq!(refused.reason, "verify_misses_producers");
        assert!(refused.message().contains("a"));
    }

    #[test]
    fn a_task_with_no_scope_is_refused_and_a_verify_task_needs_none() {
        let plan = vec![task("a", &[], &[]), checker(&["a"])];
        let refused = check_plan(plan).unwrap_err();
        assert_eq!(refused.reason, "no_write_scope");
        assert!(refused.message().contains("'.' for the whole project"));
        // The verify task writes nothing, and needs nothing.
        check_plan(vec![task("a", &["src"], &[]), checker(&["a"])]).unwrap();
    }

    #[test]
    fn duplicate_ids_unknown_dependencies_a_self_edge_and_a_cycle_are_refused() {
        let duplicate = vec![
            task("a", &["src"], &[]),
            task("a", &["docs"], &[]),
            checker(&["a"]),
        ];
        assert_eq!(
            check_plan(duplicate).unwrap_err().reason,
            "duplicate_node_id"
        );

        let unknown = vec![task("a", &["src"], &["ghost"]), checker(&["a"])];
        assert_eq!(
            check_plan(unknown).unwrap_err().reason,
            "unknown_dependency"
        );

        let itself = vec![task("a", &["src"], &["a"]), checker(&["a"])];
        assert_eq!(check_plan(itself).unwrap_err().reason, "self_dependency");

        let cycle = vec![
            task("a", &["src/a"], &["b"]),
            task("b", &["src/b"], &["a"]),
            checker(&["a", "b"]),
        ];
        assert_eq!(check_plan(cycle).unwrap_err().reason, "dependency_cycle");
    }

    #[test]
    fn a_plan_with_one_task_and_no_check_is_refused_in_plain_words() {
        assert_eq!(check_plan(Vec::new()).unwrap_err().reason, "empty_graph");
    }

    #[test]
    fn a_scope_that_only_one_pair_shares_is_not_refused_by_another_pair() {
        // Independent work on different folders, with one shared docs file made ordered.
        let plan = vec![
            task("a", &["src"], &[]),
            task("b", &["docs"], &[]),
            task("c", &["docs/notes.md"], &["b"]),
            checker(&["a", "b", "c"]),
        ];
        let answer = check_plan(plan).unwrap();
        assert!(answer
            .lint
            .iter()
            .all(|finding| !finding.contains("serial_graph")));
    }
}
