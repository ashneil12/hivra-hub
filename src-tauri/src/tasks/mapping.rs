//! One mapping from a delegation's state to a task status. Agents never set these statuses by hand.
//!
//! "Queued" and "in review" are not delegation states. Queued is `follow == "queue"`. In review is a completed report
//! whose check has not passed.

/// Where a delegation sits, for a task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Queued,
    Running,
    Question,
    InReview,
    Completed,
    Failed,
    Cancelled,
}

/// The status name and the two flags only this mapping writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub status: &'static str,
    pub needs_you: bool,
    pub failed: bool,
}

/// `state` is the delegation's state. `follow` is `queue`, `steer`, `lead` or none. `gate` is the check's verdict, or
/// none when no check applies. Cancelled wins over both. An unknown state that is not finished is running, never
/// cancelled.
pub fn phase_of(state: &str, follow: Option<&str>, gate: Option<&str>) -> Phase {
    if state == "cancelled" {
        return Phase::Cancelled;
    }
    if state == "failed" {
        return Phase::Failed;
    }
    if state == "question" {
        return Phase::Question;
    }
    if state == "completed" {
        // No gate at all is done. A blank or unknown verdict is still waiting on its check.
        return match gate {
            None => Phase::Completed,
            Some(g) => match g.trim() {
                "passed" => Phase::Completed,
                "failed" => Phase::Failed,
                _ => Phase::InReview,
            },
        };
    }
    if follow == Some("queue") {
        return Phase::Queued;
    }
    Phase::Running
}

pub fn place(phase: Phase) -> Placement {
    match phase {
        Phase::Queued => Placement {
            status: "Todo",
            needs_you: false,
            failed: false,
        },
        Phase::Running => Placement {
            status: "In progress",
            needs_you: false,
            failed: false,
        },
        Phase::Question => Placement {
            status: "In progress",
            needs_you: true,
            failed: false,
        },
        Phase::InReview => Placement {
            status: "In review",
            needs_you: false,
            failed: false,
        },
        Phase::Completed => Placement {
            status: "Done",
            needs_you: false,
            failed: false,
        },
        Phase::Failed => Placement {
            status: "In progress",
            needs_you: false,
            failed: true,
        },
        Phase::Cancelled => Placement {
            status: "Cancelled",
            needs_you: false,
            failed: false,
        },
    }
}

/// Status names this mapping owns. An agent cannot set them.
pub fn mapped(name: &str) -> bool {
    matches!(
        name,
        "Todo" | "In progress" | "In review" | "Done" | "Cancelled"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_phase_lands_on_the_workflow_name() {
        let cases = [
            (Phase::Queued, "Todo", false, false),
            (Phase::Running, "In progress", false, false),
            (Phase::Question, "In progress", true, false),
            (Phase::InReview, "In review", false, false),
            (Phase::Completed, "Done", false, false),
            (Phase::Failed, "In progress", false, true),
            (Phase::Cancelled, "Cancelled", false, false),
        ];
        for (phase, status, needs_you, failed) in cases {
            assert_eq!(
                place(phase),
                Placement {
                    status,
                    needs_you,
                    failed
                }
            );
        }
    }

    #[test]
    fn a_question_needs_you_whoever_it_waits_on() {
        assert_eq!(phase_of("question", None, None), Phase::Question);
        assert_eq!(
            phase_of("question", Some("queue"), Some("passed")),
            Phase::Question
        );
    }

    #[test]
    fn a_finished_report_waits_in_review_until_the_check_passes() {
        for gate in ["pending", "unsure", "unknown", "later", " "] {
            assert_eq!(
                phase_of("completed", None, Some(gate)),
                Phase::InReview,
                "{gate}"
            );
        }
        assert_eq!(
            phase_of("completed", Some("queue"), Some("passed")),
            Phase::Completed
        );
        assert_eq!(phase_of("completed", None, None), Phase::Completed);
        assert_eq!(phase_of("completed", None, Some("")), Phase::InReview);
        assert_eq!(phase_of("completed", None, Some("failed")), Phase::Failed);
    }

    #[test]
    fn cancelled_wins_and_an_unknown_state_is_still_running() {
        assert_eq!(
            phase_of("cancelled", Some("queue"), Some("pending")),
            Phase::Cancelled
        );
        assert_eq!(
            phase_of("failed", Some("queue"), Some("passed")),
            Phase::Failed
        );
        assert_eq!(phase_of("running", None, None), Phase::Running);
        assert_eq!(phase_of("running", Some("queue"), None), Phase::Queued);
        assert_eq!(phase_of("running", Some("steer"), None), Phase::Running);
        assert_eq!(phase_of("banana", None, Some("pending")), Phase::Running);
    }
}
