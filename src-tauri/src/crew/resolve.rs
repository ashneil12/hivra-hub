//! Precedence, one field at a time: override, then the brief, then the first matching rule, then the default.

use serde::{Deserialize, Serialize};

use crate::plugins::hivra::{CREW_CLIS, CREW_EFFORTS};

use super::rules::{first_match, Rule};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    #[serde(default)]
    pub cli: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub cli: String,
    pub installed: bool,
    pub signed_in: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub cli: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cli_from: String,
    pub model_from: String,
    pub effort_from: String,
    pub rule_index: Option<usize>,
    /// Planning help and verdict checks (WP-40). Cheap and fast, or just a low effort.
    pub plan_model: Option<String>,
    pub plan_effort: Option<String>,
    pub verdict_model: Option<String>,
    pub verdict_effort: Option<String>,
}

fn clean_model(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > 200 || text.contains(['\r', '\n']) {
        None
    } else {
        Some(text.to_string())
    }
}

fn field(value: Option<&String>, kind: &str) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() {
        return None;
    }
    match kind {
        "cli" if CREW_CLIS.contains(&text) => Some(text.to_string()),
        "effort" if CREW_EFFORTS.contains(&text) => Some(text.to_string()),
        "model" => clean_model(text),
        _ => None,
    }
}

fn pick_field(
    kind: &str,
    override_pick: Option<&Pick>,
    brief: Option<&Pick>,
    rule: Option<&Rule>,
) -> (Option<String>, &'static str) {
    let from = |pick: Option<&Pick>| {
        let pick = pick?;
        match kind {
            "cli" => field(pick.cli.as_ref(), kind),
            "model" => field(pick.model.as_ref(), kind),
            "effort" => field(pick.effort.as_ref(), kind),
            _ => None,
        }
    };
    if let Some(value) = from(override_pick) {
        return (Some(value), "override");
    }
    if let Some(value) = from(brief) {
        return (Some(value), "brief");
    }
    if let Some(rule) = rule {
        let value = match kind {
            "cli" => field(rule.cli.as_ref(), kind),
            "model" => field(rule.model.as_ref(), kind),
            "effort" => field(rule.effort.as_ref(), kind),
            _ => None,
        };
        if let Some(value) = value {
            return (Some(value), "rule");
        }
    }
    (None, "none")
}

/// Claude Code when it is installed and signed in, else the first signed-in CLI in the given order.
pub fn default_cli(present: &[Presence]) -> Option<String> {
    let usable: Vec<&Presence> = present
        .iter()
        .filter(|row| row.installed && row.signed_in && CREW_CLIS.contains(&row.cli.as_str()))
        .collect();
    if usable.iter().any(|row| row.cli == "claude") {
        return Some("claude".into());
    }
    usable.first().map(|row| row.cli.clone())
}

/// Cheap models the catalog already names. Other CLIs only drop to a low effort.
/// ROMA's idea; no ROMA text is included.
fn cheap_model(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" => Some("claude-haiku-4-5"),
        "opencode" => Some("deepseek-v4-flash"),
        "fx" => Some("zai/glm-5.2-fast"),
        _ => None,
    }
}

pub fn resolve_route(
    labels: &[String],
    paths: &[String],
    override_pick: Option<&Pick>,
    brief: Option<&Pick>,
    rules: &[Rule],
    present: &[Presence],
) -> Route {
    let rule_index = first_match(rules, labels, paths);
    let rule = rule_index.map(|index| &rules[index]);
    let (mut cli, mut cli_from) = pick_field("cli", override_pick, brief, rule);
    let (model, model_from) = pick_field("model", override_pick, brief, rule);
    let (effort, effort_from) = pick_field("effort", override_pick, brief, rule);
    if cli.is_none() {
        cli = default_cli(present);
        cli_from = if cli.is_some() { "default" } else { "none" };
    }
    let mut route = Route {
        cli,
        model: model.clone(),
        effort: effort.clone(),
        cli_from: cli_from.into(),
        model_from: if model.is_some() {
            model_from.into()
        } else {
            "none".into()
        },
        effort_from: if effort.is_some() {
            effort_from.into()
        } else {
            "none".into()
        },
        rule_index,
        plan_model: None,
        plan_effort: None,
        verdict_model: None,
        verdict_effort: None,
    };
    let (plan_model, plan_effort) = role_model("plan", &route);
    let (verdict_model, verdict_effort) = role_model("verdict", &route);
    route.plan_model = plan_model;
    route.plan_effort = plan_effort;
    route.verdict_model = verdict_model;
    route.verdict_effort = verdict_effort;
    route
}

pub fn role_model(role: &str, route: &Route) -> (Option<String>, Option<String>) {
    if role != "plan" && role != "verdict" {
        return (route.model.clone(), route.effort.clone());
    }
    let model = route
        .cli
        .as_deref()
        .and_then(cheap_model)
        .map(str::to_string);
    (model, Some("low".into()))
}
