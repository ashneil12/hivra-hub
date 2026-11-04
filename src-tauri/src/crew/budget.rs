//! Translated from Puppetmaster puppetmaster/failure_policy.py (MIT).
//! Copyright (c) 2026 Cary
//!
//! Python became Rust. A boolean is never a retry count.

use serde_json::Value;

const MAX: u64 = 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailurePolicy {
    pub action: String,
    pub retries: u64,
    pub allow_routing_change: bool,
}

pub fn normalize_failure_policy(value: &Value) -> Result<FailurePolicy, String> {
    match value {
        Value::Null => Err("on_fail must be a string or object".into()),
        Value::String(raw) => {
            let raw = raw.trim().to_lowercase();
            if raw == "abort" || raw == "continue" {
                return Ok(FailurePolicy {
                    action: raw,
                    retries: 0,
                    allow_routing_change: false,
                });
            }
            if let Some(rest) = raw
                .strip_prefix("retry(")
                .and_then(|rest| rest.strip_suffix(')'))
            {
                if rest.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty() {
                    let count: u64 = rest.parse().unwrap_or(u64::MAX);
                    if count > MAX {
                        return Err("failure policy retries must be between 0 and 10".into());
                    }
                    return Ok(FailurePolicy {
                        action: "retry".into(),
                        retries: count,
                        allow_routing_change: false,
                    });
                }
            }
            Err("on_fail must be abort, continue, or retry(n)".into())
        }
        Value::Number(number) => {
            let Some(count) = number.as_u64() else {
                return Err("failure policy retries must be an integer between 0 and 10".into());
            };
            if count > MAX {
                return Err("failure policy retries must be an integer between 0 and 10".into());
            }
            Ok(FailurePolicy {
                action: "retry".into(),
                retries: count,
                allow_routing_change: false,
            })
        }
        Value::Bool(_) => Err("on_fail must be a string or object".into()),
        Value::Array(_) => Err("on_fail must be a string or object".into()),
        Value::Object(object) => {
            let unknown: Vec<&String> = object
                .keys()
                .filter(|key| {
                    !matches!(key.as_str(), "action" | "retries" | "allow_routing_change")
                })
                .collect();
            if !unknown.is_empty() {
                let mut names: Vec<&str> = unknown.iter().map(|key| key.as_str()).collect();
                names.sort_unstable();
                return Err(format!("unknown on_fail field(s): {}", names.join(", ")));
            }
            let action = object
                .get("action")
                .and_then(Value::as_str)
                .map(|action| action.trim().to_lowercase());
            let Some(action) =
                action.filter(|action| matches!(action.as_str(), "abort" | "continue" | "retry"))
            else {
                return Err("on_fail.action must be abort, continue, or retry".into());
            };
            let has_retries = object.contains_key("retries");
            let retries = if has_retries {
                object.get("retries")
            } else {
                None
            };
            let count = match retries {
                None => 0,
                Some(Value::Number(number)) => number
                    .as_u64()
                    .filter(|count| *count <= MAX)
                    .ok_or("failure policy retries must be an integer between 0 and 10")?,
                Some(_) => {
                    return Err("failure policy retries must be an integer between 0 and 10".into())
                }
            };
            if action != "retry" && has_retries && count != 0 {
                return Err("on_fail.retries is only valid for action=retry".into());
            }
            let allow = match object.get("allow_routing_change") {
                None => false,
                Some(Value::Bool(value)) => *value,
                Some(_) => return Err("on_fail.allow_routing_change must be boolean".into()),
            };
            Ok(FailurePolicy {
                action,
                retries: count,
                allow_routing_change: allow,
            })
        }
    }
}

/// A stored budget is untrusted. Garbage falls back to 2. `abort` is 0.
pub fn budget_or_default(value: Option<&Value>) -> u64 {
    let Some(value) = value else {
        return 2;
    };
    if value.is_null() {
        return 2;
    }
    match normalize_failure_policy(value) {
        Ok(policy) if policy.action == "abort" => 0,
        Ok(policy) if policy.action == "retry" => policy.retries,
        _ => 2,
    }
}
