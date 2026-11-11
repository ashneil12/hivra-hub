//! WP-141: the first mate's pick across CLIs and Monos. One helper, no second router.
//! Presence, the roster and the caps are handed in, so a test does not need this machine.
//! The sentences match `src/features/crew/model/pick.ts`.
//! `store::pick_at` (the `crew_pick` command) is the caller: the first mate's `tasks.pick` asks it, so the pick sees the
//! stored rules and policy, who is signed in and who is cooling down after an account failure.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::plugins::hivra::{CREW_CLIS, CREW_EFFORTS};

use super::resolve::{cli_label, resolve_route, CatalogModel, Presence, RouteDefaults};
use super::rules::{first_match, Rule};

/// How deep a further Mono may sit. A brief at depth 2 would be the third Mono, and that is refused.
pub const MAX_MONO_DEPTH: i64 = 2;

const LOCK_REASON: &str = "Always use my default is on, so this override was not applied.";

#[derive(Clone, Debug, Default)]
pub struct MonoCandidate {
    pub id: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub depth: i64,
}

#[derive(Clone, Debug, Default)]
pub struct Ask {
    pub cli: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mono_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct PickQuery {
    pub labels: Vec<String>,
    pub paths: Vec<String>,
    pub rules: Vec<Rule>,
    pub present: Vec<Presence>,
    pub policy: Option<Value>,
    pub defaults: Option<RouteDefaults>,
    pub catalog: BTreeMap<String, Vec<CatalogModel>>,
    pub monos: Vec<MonoCandidate>,
    pub lead_mono_id: Option<String>,
    pub depth: i64,
    pub paused_clis: Vec<String>,
    pub at_cap: Vec<String>,
    pub override_pick: Option<Ask>,
    pub brief: Option<Ask>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatePick {
    pub ok: bool,
    pub cli: Option<String>,
    pub mono_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub reason: String,
}

struct Choice {
    kind: &'static str,
    id: String,
    name: String,
    role: i32,
    role_word: String,
    available: i32,
    fallback_rank: i32,
    default_rank: i32,
    stable: usize,
    reason: String,
}

enum Taken {
    Miss,
    Depth,
    Mono { id: String, name: String },
    Cli { id: String },
}

fn norm(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace(['\r', '\n'], "")
        .trim()
        .to_lowercase()
}

fn banned(policy: &Value, id: &str) -> bool {
    policy
        .get("neverUse")
        .and_then(Value::as_array)
        .is_some_and(|rows| rows.iter().any(|row| row.as_str() == Some(id)))
}

fn mono_name(mono: &MonoCandidate) -> String {
    let name = mono
        .name
        .as_deref()
        .unwrap_or("")
        .replace(['\r', '\n'], " ");
    let name = name.trim();
    if name.is_empty() {
        mono.id.clone()
    } else {
        name.to_string()
    }
}

fn role_title(label: Option<&str>) -> String {
    let raw = label.unwrap_or("");
    let text = norm(raw);
    if text.is_empty() {
        return "This".into();
    }
    match text.as_str() {
        "builder" => "Builder".into(),
        "reviewer" => "Reviewer".into(),
        "researcher" => "Researcher".into(),
        _ => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                "This".into()
            } else {
                trimmed.to_string()
            }
        }
    }
}

fn depth_sentence(depth: i64) -> String {
    let word = if depth >= 3 { "three" } else { "two" };
    format!("This chat is already {word} Monos deep, so another Mono was refused.")
}

fn none(reason: String) -> MatePick {
    MatePick {
        ok: false,
        cli: None,
        mono_id: None,
        model: None,
        effort: None,
        reason,
    }
}

fn cli_result(
    id: String,
    model: Option<String>,
    effort: Option<String>,
    reason: String,
) -> MatePick {
    MatePick {
        ok: true,
        cli: Some(id),
        mono_id: None,
        model,
        effort,
        reason,
    }
}

fn mono_result(id: String, reason: String) -> MatePick {
    MatePick {
        ok: true,
        cli: None,
        mono_id: Some(id),
        model: None,
        effort: None,
        reason,
    }
}

fn clean_text(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() || text.chars().count() > 200 || text.contains(['\r', '\n']) {
        None
    } else {
        Some(text.to_string())
    }
}

fn clean_effort(value: Option<&str>) -> Option<String> {
    clean_text(value).filter(|text| CREW_EFFORTS.contains(&text.as_str()))
}

fn clean_mono_id(value: Option<&str>) -> Option<String> {
    let raw = value?;
    if raw.chars().any(|ch| ch == '\n' || ch == '\r') {
        return None;
    }
    let text = raw.trim();
    if text.is_empty()
        || text.chars().count() > 64
        || text.contains("..")
        || text.contains('/')
        || text.contains('\\')
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(text.to_string())
}

fn is_cli(value: &str) -> bool {
    CREW_CLIS.contains(&value)
}

fn fields_for(query: &PickQuery, policy: &Value, cli: &str) -> (Option<String>, Option<String>) {
    let route = resolve_route(
        &query.labels,
        &query.paths,
        None,
        None,
        &query.rules,
        &query.present,
        query.defaults.as_ref(),
        &query.catalog,
        Some(policy),
    );
    if route.cli.as_deref() != Some(cli) {
        return (None, None);
    }
    (route.model, route.effort)
}

fn has_ask(ask: Option<&Ask>) -> bool {
    let Some(ask) = ask else {
        return false;
    };
    ask.cli
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty())
        || ask
            .model
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
        || ask
            .effort
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
        || ask
            .mono_id
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
}

fn ban_sentence(id: &str) -> String {
    if is_cli(id) {
        format!("{} is on Never use, so it was skipped.", cli_label(id))
    } else {
        format!("{id} is on Never use, so it was skipped.")
    }
}

fn stamp(lock: bool, mut pick: MatePick) -> MatePick {
    if lock {
        pick.reason = format!("{LOCK_REASON} {}", pick.reason);
    }
    pick
}

fn note(skipped: Option<&str>, reason: String) -> String {
    match skipped {
        Some(id) => format!("{} {reason}", ban_sentence(id)),
        None => reason,
    }
}

fn banned_target(policy: &Value, ask: Option<&Ask>) -> Option<String> {
    let mono = clean_mono_id(ask.and_then(|row| row.mono_id.as_deref()));
    if let Some(id) = mono {
        if banned(policy, &id) {
            return Some(id);
        }
    }
    let cli = ask.and_then(|row| row.cli.as_deref()).map(str::trim);
    if let Some(id) = cli {
        if is_cli(id) && banned(policy, id) {
            return Some(id.to_string());
        }
    }
    None
}

fn take_ask(
    ask: Option<&Ask>,
    roster: &[MonoCandidate],
    clis: &[&Presence],
    lead: Option<&str>,
    mono_allowed: bool,
    policy: &Value,
) -> Taken {
    let mono_id = clean_mono_id(ask.and_then(|row| row.mono_id.as_deref()));
    if let Some(id) = mono_id {
        if !banned(policy, &id) {
            let mono = roster.iter().find(|row| {
                row.id == id && Some(row.id.as_str()) != lead && row.depth < MAX_MONO_DEPTH
            });
            if let Some(mono) = mono {
                if !mono_allowed {
                    return Taken::Depth;
                }
                return Taken::Mono {
                    id: mono.id.clone(),
                    name: mono_name(mono),
                };
            }
        }
    }
    let cli = ask.and_then(|row| row.cli.as_deref()).map(str::trim);
    if let Some(id) = cli {
        if is_cli(id) && !banned(policy, id) && clis.iter().any(|row| row.cli == id) {
            return Taken::Cli { id: id.to_string() };
        }
    }
    Taken::Miss
}

/// A role match says the role; the person's own default says so.
fn default_or_role(choice: &Choice) -> String {
    if choice.role >= 2 {
        format!("{} role prefers {}.", choice.role_word, choice.name)
    } else {
        format!("Your default is {}.", choice.name)
    }
}

/// The CLI a rule or the person's Mono, project or system default names, judged by the same resolver.
fn person_set_cli(query: &PickQuery, policy: &Value) -> Option<String> {
    let route = resolve_route(
        &query.labels,
        &query.paths,
        None,
        None,
        &query.rules,
        &query.present,
        query.defaults.as_ref(),
        &query.catalog,
        Some(policy),
    );
    matches!(
        route.cli_from.as_str(),
        "rule" | "mono" | "project" | "system"
    )
    .then_some(route.cli)
    .flatten()
}

fn nothing_reason(depth: i64, had_mono: bool) -> String {
    if had_mono && depth >= MAX_MONO_DEPTH {
        depth_sentence(depth)
    } else {
        "Nothing available can take it.".into()
    }
}

fn choose(choices: &[Choice], role_cli: Option<&str>, paused: &[String]) -> Option<Choice> {
    if !choices.iter().any(|choice| choice.available == 1) {
        return None;
    }
    let mut ranked: Vec<&Choice> = choices
        .iter()
        .filter(|choice| choice.available == 1)
        .collect();
    ranked.sort_by(|left, right| {
        right
            .role
            .cmp(&left.role)
            .then(left.fallback_rank.cmp(&right.fallback_rank))
            .then(right.default_rank.cmp(&left.default_rank))
            .then(left.stable.cmp(&right.stable))
    });
    let best = *ranked.first()?;
    let paused_role = role_cli.is_some_and(|cli| paused.iter().any(|row| row == cli));
    let reason = if paused_role && role_cli != Some(best.id.as_str()) {
        format!(
            "{} is at its quota, so this uses {}.",
            cli_label(role_cli.unwrap_or("")),
            best.name
        )
    } else if best.role > 0 && best.kind == "cli" {
        default_or_role(best)
    } else if best.role > 0 && best.kind == "mono" {
        format!("{} fits the {} role.", best.name, best.role_word)
    } else if best.fallback_rank < 1000 {
        format!("Fallback order puts {} next.", best.name)
    } else {
        format!("Nothing else is set, so this uses {}.", best.name)
    };
    Some(Choice {
        kind: best.kind,
        id: best.id.clone(),
        name: best.name.clone(),
        role: best.role,
        role_word: best.role_word.clone(),
        available: best.available,
        fallback_rank: best.fallback_rank,
        default_rank: best.default_rank,
        stable: best.stable,
        reason,
    })
}

fn finish(query: &PickQuery, policy: &Value, picked: &Choice, reason: String) -> MatePick {
    if picked.kind == "mono" {
        return mono_result(picked.id.clone(), reason);
    }
    let (model, effort) = fields_for(query, policy, &picked.id);
    cli_result(picked.id.clone(), model, effort, reason)
}

/// The worker for this brief. A Mono is refused at depth 3. The reason is never empty.
/// The first mate's override is used only when Always use my default is off.
pub fn pick_mate(query: &PickQuery) -> MatePick {
    let policy = super::policy::sanitize_policy(query.policy.as_ref().unwrap_or(&Value::Null));
    let depth = query.depth;
    let clis: Vec<&Presence> = query
        .present
        .iter()
        .filter(|row| {
            row.installed && row.signed_in && is_cli(&row.cli) && !banned(&policy, &row.cli)
        })
        .collect();
    let mono_allowed = depth < MAX_MONO_DEPTH;
    // With Always use my default on, the pick is the default CLI alone: no Mono is offered.
    let lock = policy.get("lockDefault").and_then(Value::as_bool) == Some(true);
    let roster: Vec<MonoCandidate> = query
        .monos
        .iter()
        .filter_map(|mono| {
            let id = clean_mono_id(Some(&mono.id))?;
            Some(MonoCandidate {
                id,
                name: mono.name.clone(),
                role: mono.role.clone(),
                depth: mono.depth,
            })
        })
        .collect();
    let monos: Vec<&MonoCandidate> = roster
        .iter()
        .filter(|mono| {
            if lock || !mono_allowed || mono.depth >= MAX_MONO_DEPTH {
                return false;
            }
            if query.lead_mono_id.as_deref() == Some(mono.id.as_str()) {
                return false;
            }
            !banned(&policy, &mono.id)
        })
        .collect();
    let wanted: Vec<String> = query
        .labels
        .iter()
        .map(|label| norm(label))
        .filter(|label| !label.is_empty())
        .collect();
    let matched =
        first_match(&query.rules, &query.labels, &query.paths).map(|index| &query.rules[index]);
    let role_cli = matched.and_then(|rule| {
        let cli = rule.cli.as_deref()?;
        if is_cli(cli) && !banned(&policy, cli) {
            Some(cli.to_string())
        } else {
            None
        }
    });
    let role_name = role_title(matched.and_then(|rule| rule.labels.first().map(String::as_str)));
    let fallback: Vec<String> = policy
        .get("fallback")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let usual = if clis.iter().any(|row| row.cli == "claude") {
        Some("claude")
    } else {
        clis.first().map(|row| row.cli.as_str())
    };
    // The CLI the person set (a rule, or a Mono, project or system default). It ranks under a role match and above the
    // fallback order, and with Always use my default on it is the only CLI the pick may use.
    let set_cli = person_set_cli(query, &policy);
    let mut choices = Vec::new();
    for (stable, row) in clis.iter().enumerate() {
        let rank = fallback.iter().position(|id| id == &row.cli);
        choices.push(Choice {
            kind: "cli",
            id: row.cli.clone(),
            name: cli_label(&row.cli).to_string(),
            role: if role_cli.as_deref() == Some(row.cli.as_str()) {
                2
            } else if set_cli.as_deref() == Some(row.cli.as_str()) {
                1
            } else {
                0
            },
            role_word: role_name.clone(),
            available: if query.paused_clis.iter().any(|id| id == &row.cli)
                || query.at_cap.iter().any(|id| id == &row.cli)
            {
                0
            } else {
                1
            },
            fallback_rank: rank.map(|at| at as i32).unwrap_or(1000),
            default_rank: if usual == Some(row.cli.as_str()) {
                1
            } else {
                0
            },
            stable,
            reason: String::new(),
        });
    }
    for (at, mono) in monos.iter().enumerate() {
        let role = norm(mono.role.as_deref().unwrap_or(""));
        choices.push(Choice {
            kind: "mono",
            id: mono.id.clone(),
            name: mono_name(mono),
            role: if !role.is_empty() && wanted.iter().any(|label| label == &role) {
                2
            } else {
                0
            },
            role_word: role,
            available: if query.at_cap.iter().any(|id| id == &mono.id) {
                0
            } else {
                1
            },
            fallback_rank: 2000 + at as i32,
            default_rank: 0,
            stable: clis.len() + at,
            reason: String::new(),
        });
    }
    let override_set = has_ask(query.override_pick.as_ref());
    let asked = if lock {
        query.brief.as_ref()
    } else if override_set {
        query.override_pick.as_ref()
    } else {
        query.brief.as_ref().or(query.override_pick.as_ref())
    };
    let skipped = if lock {
        None
    } else {
        banned_target(&policy, query.override_pick.as_ref())
    }
    .or_else(|| {
        matched.and_then(|rule| {
            rule.cli.as_ref().and_then(|cli| {
                banned_target(
                    &policy,
                    Some(&Ask {
                        cli: Some(cli.clone()),
                        ..Ask::default()
                    }),
                )
            })
        })
    });
    let explicit = take_ask(
        asked,
        &roster,
        &clis,
        query.lead_mono_id.as_deref(),
        mono_allowed,
        &policy,
    );
    if let Taken::Depth = explicit {
        return stamp(lock && override_set, none(depth_sentence(depth)));
    }
    if let Taken::Mono { id, name } = explicit {
        return stamp(
            lock && override_set,
            mono_result(id, format!("This task asks for {name}.")),
        );
    }
    if let Taken::Cli { id } = explicit {
        let (model, effort) = fields_for(query, &policy, &id);
        let model = clean_text(asked.and_then(|row| row.model.as_deref())).or(model);
        let effort = clean_effort(asked.and_then(|row| row.effort.as_deref())).or(effort);
        return stamp(
            lock && override_set,
            cli_result(
                id.clone(),
                model,
                effort,
                format!("This task asks for {}.", cli_label(&id)),
            ),
        );
    }
    if lock {
        // The CLI the person set, else the signed-in default (Claude Code first). Never the fallback order.
        let Some(set) = set_cli.clone().or_else(|| usual.map(str::to_string)) else {
            return stamp(
                override_set,
                none(note(
                    skipped.as_deref(),
                    "Always use my default is on, and no CLI is signed in, so nothing was picked."
                        .into(),
                )),
            );
        };
        let set = set.as_str();
        let mine = choices
            .iter()
            .find(|choice| choice.kind == "cli" && choice.id == set);
        let Some(mine) = mine.filter(|choice| choice.available == 1) else {
            let name = cli_label(set);
            let why = if query.paused_clis.iter().any(|id| id == set) {
                format!("{name} is at its quota and Always use my default is on, so nothing else was picked.")
            } else {
                format!("{name} is not free and Always use my default is on, so nothing else was picked.")
            };
            return stamp(override_set, none(note(skipped.as_deref(), why)));
        };
        let reason = note(skipped.as_deref(), default_or_role(mine));
        let (model, effort) = fields_for(query, &policy, &mine.id);
        return stamp(
            override_set,
            cli_result(mine.id.clone(), model, effort, reason),
        );
    }
    let had_mono = !roster.is_empty();
    let Some(picked) = choose(
        &choices,
        role_cli.as_deref().or(set_cli.as_deref()),
        &query.paused_clis,
    ) else {
        return stamp(
            lock && override_set,
            none(note(skipped.as_deref(), nothing_reason(depth, had_mono))),
        );
    };
    let reason = note(skipped.as_deref(), picked.reason.clone());
    stamp(
        lock && override_set,
        finish(query, &policy, &picked, reason),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn signed(clis: &[&str]) -> Vec<Presence> {
        clis.iter()
            .map(|cli| Presence {
                cli: (*cli).into(),
                installed: true,
                signed_in: true,
            })
            .collect()
    }

    fn builder() -> Rule {
        Rule {
            labels: vec!["builder".into()],
            paths: vec![],
            cli: Some("codex".into()),
            model: Some("gpt-codex".into()),
            effort: Some("high".into()),
            task_ceiling_micros: None,
            source: "person".into(),
        }
    }

    fn ada() -> MonoCandidate {
        MonoCandidate {
            id: "ada".into(),
            name: Some("Ada".into()),
            role: Some("reviewer".into()),
            depth: 0,
        }
    }

    #[test]
    fn a_role_rule_prefers_that_cli() {
        let pick = pick_mate(&PickQuery {
            labels: vec!["builder".into()],
            rules: vec![builder()],
            present: signed(&["claude", "codex"]),
            ..PickQuery::default()
        });
        assert!(pick.ok);
        assert_eq!(pick.cli.as_deref(), Some("codex"));
        assert_eq!(pick.mono_id, None);
        assert_eq!(pick.model.as_deref(), Some("gpt-codex"));
        assert_eq!(pick.effort.as_deref(), Some("high"));
        assert_eq!(pick.reason, "Builder role prefers Codex.");
    }

    #[test]
    fn a_mono_that_fits_the_role_is_chosen_and_the_lead_is_not() {
        let pick = pick_mate(&PickQuery {
            labels: vec!["reviewer".into()],
            present: signed(&["claude"]),
            monos: vec![
                ada(),
                MonoCandidate {
                    id: "lead".into(),
                    name: Some("Lead".into()),
                    role: Some("reviewer".into()),
                    depth: 0,
                },
            ],
            lead_mono_id: Some("lead".into()),
            ..PickQuery::default()
        });
        assert_eq!(pick.mono_id.as_deref(), Some("ada"));
        assert_eq!(pick.cli, None);
        assert_eq!(pick.reason, "Ada fits the reviewer role.");
    }

    #[test]
    fn another_mono_is_refused_at_depth_2_and_depth_3() {
        let two = pick_mate(&PickQuery {
            labels: vec!["reviewer".into()],
            monos: vec![ada()],
            depth: 2,
            ..PickQuery::default()
        });
        assert!(!two.ok);
        assert_eq!(two.mono_id, None);
        assert_eq!(
            two.reason,
            "This chat is already two Monos deep, so another Mono was refused."
        );
        let three = pick_mate(&PickQuery {
            labels: vec!["reviewer".into()],
            present: signed(&["claude"]),
            monos: vec![ada()],
            depth: 3,
            override_pick: Some(Ask {
                mono_id: Some("ada".into()),
                ..Ask::default()
            }),
            ..PickQuery::default()
        });
        assert!(!three.ok);
        assert_eq!(
            three.reason,
            "This chat is already three Monos deep, so another Mono was refused."
        );
    }

    #[test]
    fn with_the_lock_off_an_override_still_beats_the_role() {
        let pick = pick_mate(&PickQuery {
            labels: vec!["builder".into()],
            rules: vec![builder()],
            present: signed(&["claude", "codex", "grok"]),
            override_pick: Some(Ask {
                cli: Some("grok".into()),
                ..Ask::default()
            }),
            policy: Some(json!({ "lockDefault": false, "neverUse": [], "fallback": [] })),
            ..PickQuery::default()
        });
        assert_eq!(pick.cli.as_deref(), Some("grok"));
        assert_eq!(pick.reason, "This task asks for Grok.");
    }

    #[test]
    fn the_lock_drops_the_override_and_the_brief_still_wins() {
        let locked = pick_mate(&PickQuery {
            labels: vec!["builder".into()],
            rules: vec![builder()],
            present: signed(&["claude", "codex", "grok"]),
            override_pick: Some(Ask {
                cli: Some("grok".into()),
                ..Ask::default()
            }),
            policy: Some(json!({ "lockDefault": true, "neverUse": [], "fallback": [] })),
            ..PickQuery::default()
        });
        assert_eq!(locked.cli.as_deref(), Some("codex"));
        assert_eq!(
            locked.reason,
            "Always use my default is on, so this override was not applied. Builder role prefers Codex."
        );
        let brief = pick_mate(&PickQuery {
            labels: vec!["builder".into()],
            rules: vec![builder()],
            present: signed(&["claude", "codex", "cursor"]),
            override_pick: Some(Ask {
                cli: Some("grok".into()),
                ..Ask::default()
            }),
            brief: Some(Ask {
                cli: Some("cursor".into()),
                ..Ask::default()
            }),
            policy: Some(json!({ "lockDefault": true, "neverUse": [], "fallback": [] })),
            ..PickQuery::default()
        });
        assert_eq!(brief.cli.as_deref(), Some("cursor"));
        assert!(brief.reason.contains("This task asks for Cursor."));
        assert!(brief.reason.starts_with("Always use my default is on"));
    }

    #[test]
    fn a_provider_that_is_not_signed_in_is_not_picked() {
        let pick = pick_mate(&PickQuery {
            present: vec![
                Presence {
                    cli: "grok".into(),
                    installed: true,
                    signed_in: false,
                },
                Presence {
                    cli: "claude".into(),
                    installed: true,
                    signed_in: true,
                },
            ],
            catalog: BTreeMap::from([(
                "grok".into(),
                vec![CatalogModel {
                    id: "grok-4".into(),
                    name: None,
                    efforts: vec!["low".into()],
                }],
            )]),
            ..PickQuery::default()
        });
        assert_eq!(pick.cli.as_deref(), Some("claude"));
        assert_eq!(
            pick.reason,
            "Nothing else is set, so this uses Claude Code."
        );
    }

    #[test]
    fn a_paused_role_cli_is_skipped_and_the_reason_names_the_quota() {
        let pick = pick_mate(&PickQuery {
            labels: vec!["builder".into()],
            rules: vec![builder()],
            present: signed(&["codex", "claude"]),
            paused_clis: vec!["codex".into()],
            ..PickQuery::default()
        });
        assert_eq!(pick.cli.as_deref(), Some("claude"));
        assert_eq!(
            pick.reason,
            "Codex is at its quota, so this uses Claude Code."
        );
    }

    #[test]
    fn fallback_order_then_the_signed_in_default() {
        let ordered = pick_mate(&PickQuery {
            present: signed(&["claude", "grok", "codex"]),
            policy: Some(
                json!({ "lockDefault": false, "neverUse": [], "fallback": ["grok", "codex"] }),
            ),
            ..PickQuery::default()
        });
        assert_eq!(ordered.cli.as_deref(), Some("grok"));
        assert_eq!(ordered.reason, "Fallback order puts Grok next.");
        let first = pick_mate(&PickQuery {
            present: signed(&["cursor", "codex"]),
            ..PickQuery::default()
        });
        assert_eq!(first.cli.as_deref(), Some("cursor"));
        assert_eq!(first.reason, "Nothing else is set, so this uses Cursor.");
    }

    #[test]
    fn a_banned_role_cli_is_skipped_and_its_model_is_not_kept() {
        let pick = pick_mate(&PickQuery {
            labels: vec!["builder".into()],
            rules: vec![builder()],
            present: signed(&["codex", "claude"]),
            policy: Some(json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] })),
            ..PickQuery::default()
        });
        assert_eq!(pick.cli.as_deref(), Some("claude"));
        assert_eq!(pick.model, None);
        assert_eq!(pick.effort, None);
        assert_eq!(
            pick.reason,
            "Codex is on Never use, so it was skipped. Nothing else is set, so this uses Claude Code."
        );
    }

    fn system_default(cli: &str) -> Option<RouteDefaults> {
        Some(RouteDefaults {
            system: Some(super::super::resolve::Pick {
                cli: Some(cli.into()),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    #[test]
    fn the_persons_default_comes_before_the_fallback_order() {
        let pick = pick_mate(&PickQuery {
            present: signed(&["claude", "grok", "codex"]),
            defaults: system_default("codex"),
            policy: Some(json!({ "lockDefault": false, "neverUse": [], "fallback": ["grok"] })),
            ..PickQuery::default()
        });
        assert_eq!(pick.cli.as_deref(), Some("codex"));
        assert_eq!(pick.reason, "Your default is Codex.");
        let paused = pick_mate(&PickQuery {
            present: signed(&["claude", "grok", "codex"]),
            defaults: system_default("codex"),
            paused_clis: vec!["codex".into()],
            policy: Some(json!({ "lockDefault": false, "neverUse": [], "fallback": ["grok"] })),
            ..PickQuery::default()
        });
        assert_eq!(paused.cli.as_deref(), Some("grok"));
        assert_eq!(paused.reason, "Codex is at its quota, so this uses Grok.");
    }

    #[test]
    fn the_lock_keeps_the_default_and_picks_nothing_else_at_quota() {
        let stuck = pick_mate(&PickQuery {
            present: signed(&["claude", "grok", "codex"]),
            defaults: system_default("codex"),
            paused_clis: vec!["codex".into()],
            policy: Some(json!({ "lockDefault": true, "neverUse": [], "fallback": ["grok"] })),
            ..PickQuery::default()
        });
        assert!(!stuck.ok);
        assert_eq!((stuck.cli, stuck.mono_id), (None, None));
        assert_eq!(
            stuck.reason,
            "Codex is at its quota and Always use my default is on, so nothing else was picked."
        );
        let kept = pick_mate(&PickQuery {
            labels: vec!["reviewer".into()],
            present: signed(&["claude", "codex"]),
            defaults: system_default("codex"),
            monos: vec![ada()],
            policy: Some(json!({ "lockDefault": true, "neverUse": [], "fallback": [] })),
            ..PickQuery::default()
        });
        assert_eq!(kept.cli.as_deref(), Some("codex"));
        assert_eq!(kept.mono_id, None);
        assert_eq!(kept.reason, "Your default is Codex.");
    }

    #[test]
    fn the_lock_with_nothing_set_picks_the_default_and_offers_no_mono() {
        let pick = pick_mate(&PickQuery {
            present: signed(&["codex", "claude"]),
            monos: vec![ada()],
            policy: Some(json!({ "lockDefault": true, "neverUse": [], "fallback": ["codex"] })),
            ..PickQuery::default()
        });
        assert_eq!(pick.cli.as_deref(), Some("claude"));
        assert_eq!(pick.mono_id, None);
        assert_eq!(pick.reason, "Your default is Claude Code.");
    }

    #[test]
    fn a_worker_already_at_the_cap_is_not_used_while_another_is_free() {
        let pick = pick_mate(&PickQuery {
            present: signed(&["claude", "codex"]),
            at_cap: vec!["claude".into()],
            ..PickQuery::default()
        });
        assert_eq!(pick.cli.as_deref(), Some("codex"));
        assert!(!pick.reason.is_empty());
    }
}
