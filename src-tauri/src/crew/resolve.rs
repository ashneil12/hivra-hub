//! Precedence, one field at a time: override, then the brief, then the first matching rule, then the default.

use std::collections::BTreeMap;

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

/// WP-89: one model a CLI offers, and the efforts that model offers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub efforts: Vec<String>,
}

/// WP-89: a default for one scope. The usual CLI stays `default_cli`, not `usual.cli`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDefaults {
    #[serde(default)]
    pub mono: Option<Pick>,
    #[serde(default)]
    pub project: Option<Pick>,
    #[serde(default)]
    pub system: Option<Pick>,
    #[serde(default)]
    pub usual: Option<Pick>,
}

/// A model or effort a source set that this CLI's catalog doesn't offer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub field: String,
    pub from: String,
    pub value: String,
    pub reason: String,
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
    /// Models and efforts a source set that were skipped, in the order they were tried.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<Skipped>,
}

#[derive(Clone, Copy)]
struct Source<'a> {
    from: &'static str,
    cli: Option<&'a String>,
    model: Option<&'a String>,
    effort: Option<&'a String>,
}

fn source_pick<'a>(from: &'static str, pick: Option<&'a Pick>) -> Source<'a> {
    Source {
        from,
        cli: pick.and_then(|row| row.cli.as_ref()),
        model: pick.and_then(|row| row.model.as_ref()),
        effort: pick.and_then(|row| row.effort.as_ref()),
    }
}

fn source_rule<'a>(rule: Option<&'a Rule>) -> Source<'a> {
    Source {
        from: "rule",
        cli: rule.and_then(|row| row.cli.as_ref()),
        model: rule.and_then(|row| row.model.as_ref()),
        effort: rule.and_then(|row| row.effort.as_ref()),
    }
}

/// A blank, a newline or a value past 200 characters is unset. It is not a choice, and it is not repeated.
fn usable(value: Option<&String>) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() || text.chars().count() > 200 || text.contains(['\r', '\n']) {
        None
    } else {
        Some(text.to_string())
    }
}

fn cli_label(cli: &str) -> &str {
    match cli {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "opencode" => "OpenCode",
        "pi" => "Pi",
        "omp" => "Omp",
        "fx" => "Fx",
        "grok" => "Grok",
        "hermes" => "Hermes",
        "devin" => "Devin",
        "antigravity" => "Antigravity",
        other => other,
    }
}

fn chain<'a>(
    override_pick: Option<&'a Pick>,
    brief: Option<&'a Pick>,
    rule: Option<&'a Rule>,
    defaults: Option<&'a RouteDefaults>,
) -> Vec<Source<'a>> {
    let mut rows = vec![
        source_pick("override", override_pick),
        source_pick("brief", brief),
        source_rule(rule),
    ];
    if let Some(defaults) = defaults {
        rows.push(source_pick("mono", defaults.mono.as_ref()));
        rows.push(source_pick("project", defaults.project.as_ref()));
        rows.push(source_pick("system", defaults.system.as_ref()));
    }
    rows
}

fn pick_cli(rows: &[Source<'_>], present: &[Presence]) -> (Option<String>, &'static str) {
    for row in rows {
        if let Some(value) = usable(row.cli) {
            if CREW_CLIS.contains(&value.as_str()) {
                return (Some(value), row.from);
            }
        }
    }
    let fallback = default_cli(present);
    (fallback, "default")
}

fn catalog_on(catalog: &BTreeMap<String, Vec<CatalogModel>>) -> bool {
    !catalog.is_empty()
}

fn offers<'a>(
    catalog: &'a BTreeMap<String, Vec<CatalogModel>>,
    cli: Option<&str>,
) -> Option<&'a [CatalogModel]> {
    cli.and_then(|cli| catalog.get(cli).map(Vec::as_slice))
}

fn catalog_model<'a>(
    catalog: &'a BTreeMap<String, Vec<CatalogModel>>,
    cli: Option<&str>,
    model: Option<&str>,
) -> Option<&'a CatalogModel> {
    let model = model?;
    offers(catalog, cli)?.iter().find(|row| row.id == model)
}

fn pick_model(
    rows: &[Source<'_>],
    defaults: Option<&RouteDefaults>,
    cli: Option<&str>,
    catalog: &BTreeMap<String, Vec<CatalogModel>>,
    skipped: &mut Vec<Skipped>,
) -> (Option<String>, &'static str) {
    let mut rows = rows.to_vec();
    rows.push(source_pick(
        "default",
        defaults.and_then(|row| row.usual.as_ref()),
    ));
    let listed = offers(catalog, cli);
    let who = cli.map(cli_label).unwrap_or("The CLI");
    for row in &rows {
        let Some(value) = usable(row.model) else {
            continue;
        };
        if !catalog_on(catalog) {
            return (Some(value), row.from);
        }
        // A Claude custom model is offered even when this catalog doesn't list it. Another CLI's isn't.
        if cli == Some("claude") && value.starts_with("custom:") {
            return (Some(value), row.from);
        }
        if listed.is_some_and(|models| models.iter().any(|model| model.id == value)) {
            return (Some(value), row.from);
        }
        skipped.push(Skipped {
            field: "model".into(),
            from: row.from.into(),
            value: value.clone(),
            reason: format!("{who} doesn't offer \"{value}\"."),
        });
    }
    (None, "none")
}

fn pick_effort(
    rows: &[Source<'_>],
    defaults: Option<&RouteDefaults>,
    model: Option<&CatalogModel>,
    catalog: &BTreeMap<String, Vec<CatalogModel>>,
    skipped: &mut Vec<Skipped>,
) -> (Option<String>, &'static str) {
    let mut rows = rows.to_vec();
    rows.push(source_pick(
        "default",
        defaults.and_then(|row| row.usual.as_ref()),
    ));
    let name = model
        .and_then(|row| row.name.as_deref())
        .or_else(|| model.map(|row| row.id.as_str()))
        .unwrap_or("The model");
    for row in &rows {
        let Some(value) = usable(row.effort) else {
            continue;
        };
        if !CREW_EFFORTS.contains(&value.as_str()) {
            if catalog_on(catalog) {
                skipped.push(Skipped {
                    field: "effort".into(),
                    from: row.from.into(),
                    value: value.clone(),
                    reason: format!("\"{value}\" isn't an effort."),
                });
            }
            continue;
        }
        if catalog_on(catalog)
            && model.is_some_and(|chosen| !chosen.efforts.iter().any(|effort| effort == &value))
        {
            skipped.push(Skipped {
                field: "effort".into(),
                from: row.from.into(),
                value: value.clone(),
                reason: format!("{name} doesn't offer \"{value}\"."),
            });
            continue;
        }
        return (Some(value), row.from);
    }
    (None, "none")
}

/// Claude Code when it is installed and signed in, else the first signed-in CLI in the given order.
pub fn default_cli(present: &[Presence]) -> Option<String> {
    default_cli_except(present, &[])
}

/// The same default, skipping CLIs that just failed their account.
pub fn default_cli_except(present: &[Presence], cooled: &[String]) -> Option<String> {
    let usable: Vec<&Presence> = present
        .iter()
        .filter(|row| {
            row.installed
                && row.signed_in
                && CREW_CLIS.contains(&row.cli.as_str())
                && !cooled.iter().any(|cli| cli == &row.cli)
        })
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

/// An empty catalog means no catalog: a model stays a free string, as before.
// The query, the rules, who is signed in, the defaults and the catalog stay separate arguments.
// Folding them would hide which one a caller passed.
#[allow(clippy::too_many_arguments)]
pub fn resolve_route(
    labels: &[String],
    paths: &[String],
    override_pick: Option<&Pick>,
    brief: Option<&Pick>,
    rules: &[Rule],
    present: &[Presence],
    defaults: Option<&RouteDefaults>,
    catalog: &BTreeMap<String, Vec<CatalogModel>>,
) -> Route {
    let rule_index = first_match(rules, labels, paths);
    let rule = rule_index.map(|index| &rules[index]);
    let rows = chain(override_pick, brief, rule, defaults);
    let mut skipped = Vec::new();
    let (cli, cli_from) = pick_cli(&rows, present);
    let (model, model_from) = pick_model(&rows, defaults, cli.as_deref(), catalog, &mut skipped);
    let chosen = catalog_model(catalog, cli.as_deref(), model.as_deref());
    let (effort, effort_from) = pick_effort(&rows, defaults, chosen, catalog, &mut skipped);
    let mut route = Route {
        cli: cli.clone(),
        model: model.clone(),
        effort: effort.clone(),
        cli_from: if cli.is_some() {
            cli_from.into()
        } else {
            "none".into()
        },
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
        skipped,
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
