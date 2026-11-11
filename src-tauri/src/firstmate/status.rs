//! Hivra WP-10: the five statuses everything shows (docs/hivra/SPEC.md section 4).
//!
//! `derive_status` is the only place a status is computed. It reads the delegation row and its gate verdict, never what a
//! model says about itself. The row's own `state` (delegations.rs) stays as it is; this maps it:
//!
//! | Row | Status |
//! | --- | --- |
//! | `running` | working (a quiet, loop or idle stall is a notice, not a state) |
//! | `running`, blocked by its first mate (`task_cannot` on its own task) | needs you |
//! | `running`, blocked by the worker itself | working: its first mate hears it first |
//! | `question` for the first mate (the default) | working, with a notice |
//! | `question` the first mate passed to the person | needs you |
//! | `completed`, no gates or gates passed | done |
//! | `completed`, gates still running | working |
//! | `completed`, gates failed | failed |
//! | `completed`, gates passed but the verdict check was unsure, or a gate couldn't run (WP-40) | working, with a notice: its first mate decides |
//! | `failed` on a usage limit (`resets_at`, or class `usage_limit`), not marked unretryable | paused |
//! | `failed` otherwise | failed |
//! | `cancelled` (stopped, or taken over by a later request) | failed, with a notice saying which |

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::delegations::{Delegation, CANCELLED, COMPLETED, FAILED, QUESTION, RUNNING};

/// The only states shown anywhere.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Working,
    NeedsYou,
    Done,
    Failed,
    Paused,
}

/// What the completion gates (WP-40) said about a finished task. Stored on the row as `gate_verdict`; none means the
/// task has no gates to pass.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GateVerdict {
    /// No gates apply to this task.
    NotRequired,
    /// Gates apply and have not finished.
    Pending,
    Passed,
    Failed,
    /// WP-40: the gates passed but the verdict check couldn't say the brief was met, or a gate couldn't run: its first
    /// mate decides (`task_accept`). Never done until it does.
    Unsure,
}

impl GateVerdict {
    pub const PENDING: &'static str = "pending";
    pub const PASSED: &'static str = "passed";
    pub const FAILED: &'static str = "failed";
    pub const UNSURE: &'static str = "unsure";

    /// The row's stored verdict. An unknown value is treated as not yet passed, never as passed.
    pub fn of(row: &Delegation) -> GateVerdict {
        Self::stored(row.gate_verdict.as_deref())
    }

    /// A stored verdict, as the row's `gate_verdict` column holds it.
    pub fn stored(verdict: Option<&str>) -> GateVerdict {
        match verdict {
            None => GateVerdict::NotRequired,
            Some(Self::PASSED) => GateVerdict::Passed,
            Some(Self::FAILED) => GateVerdict::Failed,
            Some(Self::UNSURE) => GateVerdict::Unsure,
            Some(_) => GateVerdict::Pending,
        }
    }
}

/// Who a row's open question waits on. A worker's question goes to its first mate first.
pub const QUESTION_FOR_PERSON: &str = "person";
pub const QUESTION_FOR_FIRST_MATE: &str = "first-mate";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedStatus {
    pub status: Status,
    /// A plain line to show beside the status, when there is something to say (a stall, a question, why it failed).
    pub notice: Option<String>,
}

fn derived(status: Status, notice: Option<String>) -> DerivedStatus {
    DerivedStatus { status, notice }
}

/// Who declared the row's current `blocked` stall, from its newest `stalled` log line.
fn blocked_by_owner(row: &Delegation) -> bool {
    let entry = row.log.iter().rev().find(|entry| {
        entry.get("event").and_then(Value::as_str) == Some("stalled")
            && entry.get("kind").and_then(Value::as_str) == Some("blocked")
    });
    match entry
        .and_then(|entry| entry.get("by"))
        .and_then(Value::as_str)
    {
        // The worker said it about its own work: its first mate reads it first.
        Some(by) if by.starts_with("self:") => false,
        // The first mate said it (`owner:`), or the line is gone from the capped log: the person's, as before.
        _ => true,
    }
}

fn with_reason(lead: &str, reason: Option<&str>) -> String {
    match reason.map(str::trim).filter(|r| !r.is_empty()) {
        Some(reason) => format!("{lead}: {reason}"),
        None => lead.to_string(),
    }
}

/// The row's status. Pure: the same row and verdict always give the same answer.
pub fn derive_status(row: &Delegation, gates: GateVerdict) -> DerivedStatus {
    match row.state.as_str() {
        RUNNING => match row.stall_kind.as_deref() {
            Some("blocked") => {
                let line = with_reason("Cannot finish", row.stall_reason.as_deref());
                if blocked_by_owner(row) {
                    derived(Status::NeedsYou, Some(line))
                } else {
                    derived(
                        Status::Working,
                        Some(format!("{line} (its first mate is on it)")),
                    )
                }
            }
            Some("quiet") => derived(
                Status::Working,
                Some(with_reason(
                    "Quiet for a while",
                    row.stall_reason.as_deref(),
                )),
            ),
            Some("loop") => derived(
                Status::Working,
                Some(with_reason("Repeating itself", row.stall_reason.as_deref())),
            ),
            Some("idle") => derived(
                Status::Working,
                Some(with_reason(
                    "Stopped without a report",
                    row.stall_reason.as_deref(),
                )),
            ),
            _ => derived(Status::Working, None),
        },
        QUESTION => {
            let question = row.pending_question.as_deref();
            if row.question_owner.as_deref() == Some(QUESTION_FOR_PERSON) {
                derived(
                    Status::NeedsYou,
                    Some(with_reason("Question for you", question)),
                )
            } else {
                derived(
                    Status::Working,
                    Some(with_reason("Asked its first mate", question)),
                )
            }
        }
        COMPLETED => match gates {
            GateVerdict::NotRequired | GateVerdict::Passed => derived(Status::Done, None),
            GateVerdict::Pending => {
                derived(Status::Working, Some("Finished; checks are running".into()))
            }
            GateVerdict::Failed => derived(
                Status::Failed,
                Some("Finished, but its checks failed".into()),
            ),
            GateVerdict::Unsure => derived(
                Status::Working,
                Some("Finished; its first mate is deciding whether the brief was met".into()),
            ),
        },
        FAILED => {
            let usage_limit =
                row.resets_at.is_some() || row.error_class.as_deref() == Some("usage_limit");
            if usage_limit && row.retryable != Some(false) {
                derived(
                    Status::Paused,
                    Some("Waiting for a usage limit to reset".into()),
                )
            } else {
                derived(
                    Status::Failed,
                    row.error.clone().filter(|e| !e.trim().is_empty()),
                )
            }
        }
        CANCELLED => {
            let superseded = row
                .log
                .iter()
                .rev()
                .any(|entry| entry.get("event").and_then(Value::as_str) == Some("superseded"));
            let notice = if superseded {
                "Taken over by a later request"
            } else {
                "Stopped"
            };
            derived(Status::Failed, Some(notice.into()))
        }
        // A state this build doesn't know: say so rather than guess it went well.
        other => derived(Status::Failed, Some(format!("Unknown state {other}"))),
    }
}

/// The row's status with its own stored gate verdict.
pub fn status_of(row: &Delegation) -> DerivedStatus {
    derive_status(row, GateVerdict::of(row))
}

/// Whether a row in `state` with this stored gate verdict shows as `done`, without loading the row (the worktree
/// clean-up asks it of every row). It is `status_of(row).status == Status::Done`; a test keeps the two together.
pub fn is_done(state: &str, gate_verdict: Option<&str>) -> bool {
    state == COMPLETED
        && matches!(
            GateVerdict::stored(gate_verdict),
            GateVerdict::NotRequired | GateVerdict::Passed
        )
}
