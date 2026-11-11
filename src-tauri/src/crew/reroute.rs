//! Account failures move. The work itself never does. A timeout is not final.
//! WP-141: a saved fallback list is walked instead of presence order. The lock does not invent another CLI.

use serde::Serialize;
use serde_json::Value;

use super::budget::budget_or_default;
use super::failure::Kind;
use super::resolve::{cli_label, Pick, Presence};
use crate::plugins::hivra::CREW_CLIS;

const LOCK_REASON: &str = "Always use my default is on, so another CLI was not used.";

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
    /// Banned and unsigned entries passed over on the way, in order.
    pub skipped: Vec<Attempt>,
}

pub struct FailureInput<'a> {
    pub error_class: Option<&'a str>,
    pub text: Option<&'a str>,
    pub resets_at: Option<i64>,
    pub now: i64,
    pub current: &'a Pick,
    pub present: &'a [Presence],
    pub ledger: &'a [Attempt],
    pub budget: Option<&'a Value>,
    /// Untrusted. Missing keeps today's presence order and today's reasons.
    pub policy: Option<&'a Value>,
}

struct Choice {
    cli: Option<String>,
    skipped: Vec<Attempt>,
}

fn spent(ledger: &[Attempt]) -> u64 {
    ledger
        .iter()
        .filter(|row| row.outcome == "rerouted" || row.outcome == "again")
        .count() as u64
}

fn tried(ledger: &[Attempt], cli: &str) -> bool {
    // A skip is not an attempt. Signing in, or taking a ban off, offers that CLI again.
    ledger
        .iter()
        .any(|attempt| attempt.outcome != "skipped" && attempt.cli.as_deref() == Some(cli))
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

fn skip_attempt(input: &FailureInput<'_>, cli: &str, reason: String) -> Attempt {
    Attempt {
        at: input.now,
        cli: Some(cli.to_string()),
        model: None,
        effort: None,
        error_class: reason,
        outcome: "skipped".into(),
        to: None,
    }
}

fn sentence(reason: &str) -> String {
    let mut chars = reason.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn note(skipped: &[Attempt], reason: &str) -> String {
    let reason = sentence(reason);
    if skipped.is_empty() {
        return reason;
    }
    let lines: Vec<&str> = skipped.iter().map(|row| row.error_class.as_str()).collect();
    format!("{} {reason}", lines.join(" "))
}

fn switch_reason(from: Option<&str>, to: &str) -> String {
    let who = from
        .filter(|cli| CREW_CLIS.contains(cli))
        .map(cli_label)
        .unwrap_or("This CLI");
    format!("{who} can't take it, so this uses {}.", cli_label(to))
}

fn known(cli: &str) -> bool {
    CREW_CLIS.contains(&cli)
}

/// `true` when this id can take the work. A refusal is recorded on `skipped`.
fn consider(
    input: &FailureInput<'_>,
    never: &[String],
    id: &str,
    listed: bool,
    skipped: &mut Vec<Attempt>,
) -> bool {
    if !known(id) || tried(input.ledger, id) {
        return false;
    }
    if never.iter().any(|banned| banned == id) {
        skipped.push(skip_attempt(
            input,
            id,
            format!("{} is on Never use, so it was skipped.", cli_label(id)),
        ));
        return false;
    }
    if input.current.cli.as_deref() == Some(id) {
        return false;
    }
    let row = input.present.iter().find(|row| row.cli == id);
    if !listed {
        return row.is_some_and(|row| row.installed && row.signed_in);
    }
    if !row.is_some_and(|row| row.installed) {
        skipped.push(skip_attempt(
            input,
            id,
            format!("{} isn't installed here, so it was skipped.", cli_label(id)),
        ));
        return false;
    }
    if !row.is_some_and(|row| row.signed_in) {
        skipped.push(skip_attempt(
            input,
            id,
            format!("{} isn't signed in, so it was skipped.", cli_label(id)),
        ));
        return false;
    }
    true
}

fn next_candidate(input: &FailureInput<'_>, fallback: &[String], never: &[String]) -> Choice {
    let mut skipped = Vec::new();
    let listed = !fallback.is_empty();
    let presence: Vec<&str> = input.present.iter().map(|row| row.cli.as_str()).collect();
    let order: Vec<&str> = if listed {
        fallback.iter().map(String::as_str).collect()
    } else {
        presence
    };
    for id in order {
        if !consider(input, never, id, listed, &mut skipped) {
            continue;
        }
        return Choice {
            cli: Some(id.to_string()),
            skipped,
        };
    }
    Choice { cli: None, skipped }
}

fn finish(
    action: &str,
    to: Option<String>,
    until: Option<i64>,
    reason: String,
    attempt: Attempt,
    skipped: Vec<Attempt>,
) -> Decision {
    Decision {
        action: action.into(),
        to,
        until,
        reason,
        attempt,
        skipped,
    }
}

pub fn decide(input: &FailureInput<'_>) -> Decision {
    let kind = super::failure::failure_kind(input.error_class, input.text);
    let budget = budget_or_default(input.budget);
    let used = spent(input.ledger);
    let clean = super::policy::sanitize_policy(input.policy.unwrap_or(&Value::Null));
    let lock = clean.get("lockDefault").and_then(Value::as_bool) == Some(true);
    let never = clean
        .get("neverUse")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let fallback = clean
        .get("fallback")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let choice = next_candidate(input, &fallback, &never);
    let named = !fallback.is_empty() || !choice.skipped.is_empty();
    let locked = lock && choice.cli.is_some();
    let next = if locked { None } else { choice.cli.clone() };

    if matches!(kind, Kind::Task) {
        return finish(
            "first-mate",
            None,
            None,
            "the work failed".into(),
            attempt(input, "first-mate", None),
            Vec::new(),
        );
    }
    if matches!(kind, Kind::Again) {
        if used < budget {
            return finish(
                "again",
                None,
                None,
                "the CLI didn't answer".into(),
                attempt(input, "again", None),
                Vec::new(),
            );
        }
        return finish(
            "first-mate",
            None,
            None,
            "the CLI didn't answer".into(),
            attempt(input, "first-mate", None),
            Vec::new(),
        );
    }
    if locked {
        if matches!(kind, Kind::Usage) && input.resets_at.is_some_and(|at| at <= input.now) {
            return finish(
                "resume",
                None,
                None,
                note(&[], "the usage limit has reset"),
                attempt(input, "resumed", None),
                Vec::new(),
            );
        }
        let reason = note(&choice.skipped, LOCK_REASON);
        if input.resets_at.is_some_and(|at| at > input.now) {
            return finish(
                "pause",
                None,
                input.resets_at,
                reason,
                attempt(input, "paused", None),
                choice.skipped,
            );
        }
        return finish(
            "first-mate",
            None,
            None,
            reason,
            attempt(input, "first-mate", None),
            choice.skipped,
        );
    }
    if let Some(to) = next.as_ref() {
        if used < budget {
            let reason = if named {
                note(
                    &choice.skipped,
                    &switch_reason(input.current.cli.as_deref(), to),
                )
            } else {
                "the account can't take it".into()
            };
            return finish(
                "reroute",
                Some(to.clone()),
                None,
                reason,
                attempt(input, "rerouted", Some(to.clone())),
                choice.skipped,
            );
        }
    }
    if matches!(kind, Kind::Usage) && next.is_none() {
        if let Some(resets_at) = input.resets_at {
            if resets_at <= input.now {
                return finish(
                    "resume",
                    None,
                    None,
                    note(&choice.skipped, "the usage limit has reset"),
                    attempt(input, "resumed", None),
                    choice.skipped,
                );
            }
            return finish(
                "pause",
                None,
                Some(resets_at),
                note(&choice.skipped, "waiting for a usage limit to reset"),
                attempt(input, "paused", None),
                choice.skipped,
            );
        }
    }
    if next.is_none() {
        return finish(
            "first-mate",
            None,
            None,
            note(&choice.skipped, "no other worker can take it"),
            attempt(input, "first-mate", None),
            choice.skipped,
        );
    }
    finish(
        "first-mate",
        None,
        None,
        note(&choice.skipped, "the retry budget is spent"),
        attempt(input, "first-mate", None),
        choice.skipped,
    )
}
