//! Account failures move. The work itself never does. A timeout is not final.

use serde::Serialize;

use super::budget::budget_or_default;
use super::failure::Kind;
use super::resolve::{Pick, Presence};
use crate::plugins::hivra::CREW_CLIS;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub at: i64,
    pub cli: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub error_class: String,
    pub outcome: String,
    pub to: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub action: String,
    pub to: Option<String>,
    pub until: Option<i64>,
    pub reason: String,
    pub attempt: Attempt,
}

pub struct FailureInput<'a> {
    pub error_class: Option<&'a str>,
    pub text: Option<&'a str>,
    pub resets_at: Option<i64>,
    pub now: i64,
    pub current: &'a Pick,
    pub present: &'a [Presence],
    pub ledger: &'a [Attempt],
    pub budget: Option<&'a serde_json::Value>,
    /// WP-176. The move's target is a model its provider bills per token. Off unless the caller knows it.
    pub target_billed: bool,
    /// WP-176. The person has OK'd a move onto a billed model for this task. Only `true` counts.
    pub person_ok: bool,
}

fn spent(ledger: &[Attempt]) -> u64 {
    ledger
        .iter()
        .filter(|row| row.outcome == "rerouted" || row.outcome == "again")
        .count() as u64
}

pub fn next_candidate(current: &Pick, present: &[Presence], ledger: &[Attempt]) -> Option<String> {
    present.iter().find_map(|row| {
        if !row.installed || !row.signed_in || !CREW_CLIS.contains(&row.cli.as_str()) {
            return None;
        }
        if current.cli.as_deref() == Some(row.cli.as_str()) {
            return None;
        }
        if ledger
            .iter()
            .any(|attempt| attempt.cli.as_deref() == Some(row.cli.as_str()))
        {
            return None;
        }
        Some(row.cli.clone())
    })
}

fn attempt(input: &FailureInput<'_>, outcome: &str, to: Option<String>) -> Attempt {
    Attempt {
        at: input.now,
        cli: input.current.cli.clone(),
        model: input.current.model.clone(),
        effort: input.current.effort.clone(),
        error_class: input
            .error_class
            .filter(|text| !text.trim().is_empty())
            .unwrap_or("unknown")
            .to_string(),
        outcome: outcome.into(),
        to,
    }
}

/// WP-176 item 10. A reroute onto a billed model waits for the person's OK. Without it the task stays with the first
/// mate, and the attempt is recorded as that, not as a move.
pub fn refuse_unapproved_billed(
    decision: Decision,
    target_billed: bool,
    person_ok: bool,
) -> Decision {
    if decision.action != "reroute" || !target_billed || person_ok {
        return decision;
    }
    Decision {
        action: "first-mate".into(),
        to: None,
        until: None,
        reason: "a billed model needs your OK before this task moves".into(),
        attempt: Attempt {
            outcome: "first-mate".into(),
            to: None,
            ..decision.attempt
        },
    }
}

pub fn decide(input: &FailureInput<'_>) -> Decision {
    refuse_unapproved_billed(
        decide_unguarded(input),
        input.target_billed,
        input.person_ok,
    )
}

fn decide_unguarded(input: &FailureInput<'_>) -> Decision {
    let kind = super::failure::failure_kind(input.error_class, input.text);
    let budget = budget_or_default(input.budget);
    let used = spent(input.ledger);
    let next = next_candidate(input.current, input.present, input.ledger);
    if matches!(kind, Kind::Task) {
        return Decision {
            action: "first-mate".into(),
            to: None,
            until: None,
            reason: "the work failed".into(),
            attempt: attempt(input, "first-mate", None),
        };
    }
    if matches!(kind, Kind::Again) {
        if used < budget {
            return Decision {
                action: "again".into(),
                to: None,
                until: None,
                reason: "the CLI didn't answer".into(),
                attempt: attempt(input, "again", None),
            };
        }
        return Decision {
            action: "first-mate".into(),
            to: None,
            until: None,
            reason: "the CLI didn't answer".into(),
            attempt: attempt(input, "first-mate", None),
        };
    }
    if let Some(to) = next.as_ref() {
        if used < budget {
            return Decision {
                action: "reroute".into(),
                to: Some(to.clone()),
                until: None,
                reason: "the account can't take it".into(),
                attempt: attempt(input, "rerouted", Some(to.clone())),
            };
        }
    }
    if matches!(kind, Kind::Usage) && next.is_none() {
        if let Some(resets_at) = input.resets_at {
            if resets_at <= input.now {
                return Decision {
                    action: "resume".into(),
                    to: None,
                    until: None,
                    reason: "the usage limit has reset".into(),
                    attempt: attempt(input, "resumed", None),
                };
            }
            return Decision {
                action: "pause".into(),
                to: None,
                until: Some(resets_at),
                reason: "waiting for a usage limit to reset".into(),
                attempt: attempt(input, "paused", None),
            };
        }
    }
    if next.is_none() {
        return Decision {
            action: "first-mate".into(),
            to: None,
            until: None,
            reason: "no other worker can take it".into(),
            attempt: attempt(input, "first-mate", None),
        };
    }
    Decision {
        action: "first-mate".into(),
        to: None,
        until: None,
        reason: "the retry budget is spent".into(),
        attempt: attempt(input, "first-mate", None),
    }
}
