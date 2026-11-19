//! Ordered crew rules. A stored rule is untrusted: a broken one is dropped.

use serde::{Deserialize, Serialize};

use crate::plugins::hivra::{check_crew_rule, CrewRule as PluginRule, CREW_CLIS, CREW_EFFORTS};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub labels: Vec<String>,
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// WP-176. Measured-cost cap in micro-dollars. Absent means this rule sets no ceiling.
    /// A plugin rule never carries one. `i64::MIN` means the stored number was refused.
    #[serde(
        default,
        rename = "taskCeilingUsd",
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_ceiling",
        deserialize_with = "de_ceiling"
    )]
    pub task_ceiling_micros: Option<i64>,
    pub source: String,
}

const MAX_CEILING_USD: f64 = 1_000_000_000.0;

/// A positive dollar amount as micro-dollars, or nothing when it is not one.
pub fn ceiling_micros(usd: f64) -> Option<i64> {
    if !usd.is_finite() || usd <= 0.0 || usd > MAX_CEILING_USD {
        return None;
    }
    let scaled = (usd * 1_000_000.0).round();
    if scaled < 1.0 || scaled > i64::MAX as f64 {
        return None;
    }
    Some(scaled as i64)
}

fn ser_ceiling<S: serde::Serializer>(
    value: &Option<i64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value.and_then(|micros| (micros > 0).then_some(micros as f64 / 1_000_000.0)) {
        Some(usd) => serializer.serialize_f64(usd),
        None => serializer.serialize_none(),
    }
}

/// A missing ceiling is off. A present one that is not a positive amount is marked refused.
fn de_ceiling<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        None => None,
        Some(serde_json::Value::Number(number)) => match number.as_f64() {
            Some(usd) => Some(ceiling_micros(usd).unwrap_or(i64::MIN)),
            None => Some(i64::MIN),
        },
        Some(_) => Some(i64::MIN),
    })
}

const MAX_RULES: usize = 40;

/// Split on `/` and `\`, drop empty and `.`, and refuse `..`.
pub fn path_segments(path: &str) -> Option<Vec<String>> {
    let text = path.replace("\r\n", "\n").replace(['\r', '\n'], "");
    let mut parts = Vec::new();
    for part in text.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        parts.push(part.to_string());
    }
    Some(parts)
}

pub fn path_matches(task_path: &str, rule_path: &str) -> bool {
    let Some(task) = path_segments(task_path) else {
        return false;
    };
    let Some(rule) = path_segments(rule_path) else {
        return false;
    };
    if task.is_empty() || rule.is_empty() || task.len() < rule.len() {
        return false;
    }
    rule.iter().zip(task.iter()).all(|(want, got)| want == got)
}

pub fn norm_label(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace(['\r', '\n'], "")
        .trim()
        .to_lowercase()
}

fn clean_model(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > 200 || text.contains(['\r', '\n']) {
        None
    } else {
        Some(text.to_string())
    }
}

/// What the editor sends. The same checks as a plugin rule, so the two stores can't drift.
pub fn validate_rule(rule: &Rule) -> Result<PluginRule, String> {
    let mut object = serde_json::Map::new();
    let mut matcher = serde_json::Map::new();
    matcher.insert("labels".into(), serde_json::json!(rule.labels));
    matcher.insert("paths".into(), serde_json::json!(rule.paths));
    object.insert("match".into(), serde_json::Value::Object(matcher));
    if let Some(cli) = rule
        .cli
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        object.insert("cli".into(), serde_json::json!(cli));
    }
    if let Some(model) = rule.model.as_ref().and_then(|v| clean_model(v)) {
        object.insert("model".into(), serde_json::json!(model));
    }
    if let Some(effort) = rule
        .effort
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        object.insert("effort".into(), serde_json::json!(effort));
    }
    check_crew_rule(&serde_json::Value::Object(object))
}

pub fn from_plugin(rule: PluginRule, source: &str) -> Rule {
    Rule {
        labels: rule
            .labels
            .iter()
            .map(|label| norm_label(label))
            .filter(|label| !label.is_empty())
            .collect(),
        paths: rule.paths.clone(),
        cli: rule.cli.filter(|cli| CREW_CLIS.contains(&cli.as_str())),
        model: rule.model.as_deref().and_then(clean_model),
        effort: rule
            .effort
            .filter(|effort| CREW_EFFORTS.contains(&effort.as_str())),
        // A plugin cannot set a spend ceiling.
        task_ceiling_micros: None,
        source: source.to_string(),
    }
}

/// Every dimension a rule sets has to hit. An empty task matches nothing.
pub fn rule_matches(rule: &Rule, labels: &[String], paths: &[String]) -> bool {
    let wanted: Vec<String> = labels
        .iter()
        .map(|label| norm_label(label))
        .filter(|label| !label.is_empty())
        .collect();
    let files: Vec<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|path| !path.trim().is_empty())
        .collect();
    if wanted.is_empty() && files.is_empty() {
        return false;
    }
    if !rule.labels.is_empty()
        && !rule
            .labels
            .iter()
            .any(|label| wanted.iter().any(|got| got == label))
    {
        return false;
    }
    if !rule.paths.is_empty()
        && !rule
            .paths
            .iter()
            .any(|rule_path| files.iter().any(|file| path_matches(file, rule_path)))
    {
        return false;
    }
    !rule.labels.is_empty() || !rule.paths.is_empty()
}

pub fn merge_rules(
    mono: &[Rule],
    project: &[Rule],
    system: &[Rule],
    plugins: &[Rule],
) -> Vec<Rule> {
    mono.iter()
        .chain(project.iter())
        .chain(system.iter())
        .chain(plugins.iter())
        .take(MAX_RULES)
        .cloned()
        .collect()
}

pub fn first_match(rules: &[Rule], labels: &[String], paths: &[String]) -> Option<usize> {
    rules
        .iter()
        .position(|rule| rule_matches(rule, labels, paths))
}
