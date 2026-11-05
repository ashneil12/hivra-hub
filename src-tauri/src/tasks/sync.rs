//! A delegation and its task stay in step. Called from `delegations::save` and both commits in `record`.

use super::store::{self, SyncRequest};

/// `task_id` is set only when a person's task is being picked up (`record`). Later saves find the task by the
/// delegation id.
pub fn on_delegation(
    conn: &rusqlite::Connection,
    delegation: &crate::delegations::Delegation,
    task_id: Option<&str>,
) -> Result<(), String> {
    let assignee = delegation
        .owner_mono
        .as_deref()
        .filter(|mono| !mono.is_empty())
        .unwrap_or(delegation.owner_session.as_str());
    store::sync_delegation(
        conn,
        &SyncRequest {
            delegation_id: delegation.id.clone(),
            parent_delegation_id: delegation.parent_id.clone(),
            project: delegation.project.clone(),
            title: delegation.title.clone(),
            brief: delegation.brief.clone(),
            state: delegation.state.clone(),
            follow: delegation.follow.clone(),
            gate: delegation.gate_verdict.clone(),
            assignee: assignee.to_string(),
            created_by: delegation.owner_session.clone(),
            updated_at: delegation.updated_at,
            task_id: task_id.map(str::to_string),
        },
    )
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
