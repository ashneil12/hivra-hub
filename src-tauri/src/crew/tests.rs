//! WP-13: precedence, the signed-in default, which failures move, the retry budget, and a usage limit that waits.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::budget::{budget_or_default, normalize_failure_policy};
use super::failure::{self, Kind};
use super::reroute::{decide, Attempt, FailureInput};
use super::resolve::{role_model, CatalogModel, Pick, Presence, RouteDefaults, Skipped};
use super::rules::{self, Rule};
use super::store::{self, FailureQuery, RouteQuery, RuleDraft};
use crate::delegations::{self, DeliveryInput, RecordInput, SettleInput};
use crate::session_store::SessionStore;

fn memory() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn draft(labels: &str, paths: &str, cli: &str, model: &str, effort: &str) -> RuleDraft {
    RuleDraft {
        labels: split(labels),
        paths: split(paths),
        cli: some(cli),
        model: some(model),
        effort: some(effort),
        task_ceiling_usd: None,
    }
}

fn split(text: &str) -> Vec<String> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split(',').map(str::to_string).collect()
    }
}

fn some(text: &str) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text.into())
    }
}

fn present(rows: &[(&str, bool, bool)]) -> Vec<Presence> {
    rows.iter()
        .map(|(cli, installed, signed_in)| Presence {
            cli: (*cli).into(),
            installed: *installed,
            signed_in: *signed_in,
        })
        .collect()
}

fn query(
    labels: &str,
    paths: &str,
    project: &str,
    mono: &str,
    override_pick: Option<Pick>,
    brief: Option<Pick>,
    who: &[(&str, bool, bool)],
) -> RouteQuery {
    RouteQuery {
        labels: split(labels),
        paths: split(paths),
        override_pick,
        brief,
        project: some(project),
        mono: some(mono),
        present: present(who),
        mono_rules: Vec::new(),
        defaults: None,
        catalog: std::collections::BTreeMap::new(),
    }
}

fn save(
    conn: &mut Connection,
    scope: &str,
    id: &str,
    rules: Vec<RuleDraft>,
    revision: i64,
    budget: Option<&Value>,
) -> Result<store::StoredRules, String> {
    store::set_rules(conn, scope, id, &rules, revision, budget)
}

const PROJECT: &str = "/no/such/crew project/ünicode";

fn fail_row(
    conn: &mut Connection,
    child: &str,
    class: Option<&str>,
    resets_at: Option<i64>,
) -> delegations::Delegation {
    let row = delegations::record(
        conn,
        RecordInput {
            owner_session: "lead".into(),
            request_id: format!("req-{child}"),
            child_session: child.into(),
            ..RecordInput::default()
        },
        1_000,
    )
    .unwrap();
    delegations::settle(
        conn,
        SettleInput {
            id: row.id.clone(),
            generation: row.generation,
            state: "failed".into(),
            error_class: class.map(str::to_string),
            resets_at,
            ..SettleInput::default()
        },
        1_100,
    )
    .unwrap()
    .row
    .unwrap()
}

fn failure<'a>(
    id: &'a str,
    class: Option<&'a str>,
    text: Option<&'a str>,
    current: &'a str,
    who: &'a [(&'a str, bool, bool)],
    project: Option<&'a str>,
    mono: Option<&'a str>,
) -> FailureQuery {
    FailureQuery {
        delegation_id: id.into(),
        error_class: class.map(str::to_string),
        text: text.map(str::to_string),
        resets_at: None,
        current: Pick {
            cli: some(current),
            model: some("opus"),
            effort: some("high"),
        },
        present: present(who),
        project: project.map(str::to_string),
        mono: mono.map(str::to_string),
    }
}

fn running_row(conn: &mut Connection, child: &str, request: &str) -> delegations::Delegation {
    delegations::record(
        conn,
        RecordInput {
            owner_session: "lead".into(),
            request_id: request.into(),
            child_session: child.into(),
            ..RecordInput::default()
        },
        1_000,
    )
    .unwrap()
}

fn pause_input(id: &str, resets_at: Option<i64>, cli: &str) -> store::PauseQuery {
    store::PauseQuery {
        delegation_id: id.into(),
        resets_at,
        current: Pick {
            cli: some(cli),
            model: some("opus"),
            effort: some("high"),
        },
    }
}

fn hold_count(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM crew_holds WHERE delegation_id = ?1",
        [id],
        |row| row.get(0),
    )
    .unwrap()
}

fn outcomes(conn: &Connection, id: &str) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT outcome FROM crew_attempts WHERE delegation_id = ?1 ORDER BY n")
        .unwrap();
    statement
        .query_map([id], |row| row.get(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
}

#[test]
fn paths_keep_spaces_and_unicode_and_refuse_parent_segments() {
    assert!(rules::path_matches(
        "My Documents/notes.txt",
        "My Documents"
    ));
    assert!(rules::path_matches("src/ünicode/file.ts", "src/ünicode"));
    assert!(rules::path_matches("src\\app\\main.tsx", "src/app"));
    assert!(rules::path_matches("src/app\r\n", "src/app"));
    assert!(rules::path_matches("src/./app/main.tsx", "src/app"));
    assert!(rules::path_matches("src/app", "src/app"));
    assert!(!rules::path_matches("src/application", "src/app"));
    assert!(!rules::path_matches("../src/app", "src"));
    assert!(!rules::path_matches("src/../app", "app"));
    assert!(!rules::path_matches("Src/App", "src/app"));
    let both = Rule {
        labels: vec!["ui".into()],
        paths: vec!["src/app".into()],
        cli: Some("cursor".into()),
        model: None,
        effort: None,
        task_ceiling_micros: None,
        source: "person".into(),
    };
    assert!(!rules::rule_matches(&both, &["ui".into()], &[]));
    assert!(!rules::rule_matches(&both, &[], &[]));
    assert!(rules::rule_matches(
        &both,
        &["UI\r\n".into()],
        &["src/app/main.tsx".into()]
    ));
}

#[test]
fn precedence_is_one_field_at_a_time_and_the_default_is_a_signed_in_cli() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("ui", "src/app", "cursor", "composer", "medium")],
        0,
        None,
    )
    .unwrap();
    let signed = [("codex", true, true), ("claude", true, true)];
    let routed = store::route(
        &conn,
        &query(
            "ui",
            "src/app/main.tsx",
            PROJECT,
            "",
            Some(Pick {
                cli: None,
                model: None,
                effort: Some("high".into()),
            }),
            None,
            &signed,
        ),
        &[],
    )
    .unwrap();
    assert_eq!(routed.cli.as_deref(), Some("cursor"));
    assert_eq!(routed.effort.as_deref(), Some("high"));
    assert_eq!(routed.model.as_deref(), Some("composer"));
    assert_eq!(routed.cli_from, "rule");
    assert_eq!(routed.effort_from, "override");
    let unknown = store::route(
        &conn,
        &query(
            "ui",
            "src/app",
            PROJECT,
            "",
            Some(Pick {
                cli: Some("nope".into()),
                model: None,
                effort: None,
            }),
            Some(Pick {
                cli: None,
                model: Some("from-brief".into()),
                effort: None,
            }),
            &signed,
        ),
        &[],
    )
    .unwrap();
    assert_eq!(unknown.cli.as_deref(), Some("cursor"));
    assert_eq!(unknown.model.as_deref(), Some("from-brief"));
    assert_eq!(unknown.model_from, "brief");
    let open = store::route(
        &conn,
        &query("docs", "", PROJECT, "", None, None, &signed),
        &[],
    )
    .unwrap();
    assert_eq!(open.cli.as_deref(), Some("claude"));
    assert_eq!(open.model, None);
    assert_eq!(open.cli_from, "default");
    let codex_only = [
        ("claude", true, false),
        ("codex", true, true),
        ("notepad", true, true),
    ];
    let fallback = store::route(
        &conn,
        &query("docs", "", PROJECT, "", None, None, &codex_only),
        &[],
    )
    .unwrap();
    assert_eq!(fallback.cli.as_deref(), Some("codex"));
    let nobody = store::route(
        &conn,
        &query(
            "docs",
            "",
            PROJECT,
            "",
            None,
            None,
            &[("claude", true, false)],
        ),
        &[],
    )
    .unwrap();
    assert_eq!(nobody.cli, None);
    let (plan, plan_effort) = role_model("plan", &routed);
    assert_eq!(plan, None);
    assert_eq!(plan_effort.as_deref(), Some("low"));
    let (cheap, cheap_effort) = role_model("verdict", &open);
    assert_eq!(cheap.as_deref(), Some("claude-haiku-4-5"));
    assert_eq!(cheap_effort.as_deref(), Some("low"));
    let (work, work_effort) = role_model("work", &routed);
    assert_eq!(work.as_deref(), Some("composer"));
    assert_eq!(work_effort.as_deref(), Some("high"));
}

fn offered(id: &str, name: &str, efforts: &[&str]) -> CatalogModel {
    CatalogModel {
        id: id.into(),
        name: Some(name.into()),
        efforts: efforts.iter().map(|effort| (*effort).to_string()).collect(),
    }
}

fn stand_in_catalog() -> std::collections::BTreeMap<String, Vec<CatalogModel>> {
    let mut catalog = std::collections::BTreeMap::new();
    catalog.insert(
        "claude".into(),
        vec![
            offered("claude:opus-4-7", "Opus 4.7", &["low", "high", "max"]),
            offered("claude:sonnet-5", "Sonnet", &["low", "medium", "high"]),
        ],
    );
    catalog.insert(
        "cursor".into(),
        vec![offered("composer", "Composer", &["medium", "high"])],
    );
    catalog.insert(
        "grok".into(),
        vec![offered("grok-4", "Grok 4", &["low", "high"])],
    );
    catalog
}

fn pick(cli: &str, model: &str, effort: &str) -> Option<Pick> {
    Some(Pick {
        cli: some(cli),
        model: some(model),
        effort: some(effort),
    })
}

/// WP-89: each field comes from the first source that sets it, and a catalog miss falls through.
#[test]
fn a_worker_default_is_one_field_at_a_time_and_a_rule_still_beats_it() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let signed = [("claude", true, true)];
    let mut open = query("", "", "", "", None, None, &signed);
    open.defaults = Some(RouteDefaults {
        mono: pick("grok", "grok-4", "low"),
        project: pick("cursor", "composer", "medium"),
        system: pick("codex", "gpt-5", "high"),
        usual: pick("", "claude:sonnet-5", "medium"),
    });
    open.catalog = stand_in_catalog();
    let from_mono = store::route(&conn, &open, &[]).unwrap();
    assert_eq!(from_mono.cli.as_deref(), Some("grok"));
    assert_eq!(from_mono.cli_from, "mono");
    assert_eq!(from_mono.model.as_deref(), Some("grok-4"));
    assert_eq!(from_mono.model_from, "mono");
    assert_eq!(from_mono.effort.as_deref(), Some("low"));
    assert_eq!(from_mono.effort_from, "mono");

    let mut split = query("", "", "", "", None, None, &signed);
    split.defaults = Some(RouteDefaults {
        mono: pick("grok", "", ""),
        project: pick("", "grok-4", ""),
        system: pick("", "", "high"),
        usual: None,
    });
    split.catalog = stand_in_catalog();
    let split = store::route(&conn, &split, &[]).unwrap();
    assert_eq!(split.cli_from, "mono");
    assert_eq!(split.model.as_deref(), Some("grok-4"));
    assert_eq!(split.model_from, "project");
    assert_eq!(split.effort.as_deref(), Some("high"));
    assert_eq!(split.effort_from, "system");

    save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("ui", "src/app", "cursor", "composer", "high")],
        0,
        None,
    )
    .unwrap();
    let mut ruled = query("ui", "src/app/main.tsx", PROJECT, "", None, None, &signed);
    ruled.defaults = open.defaults.clone();
    ruled.catalog = stand_in_catalog();
    let ruled = store::route(&conn, &ruled, &[]).unwrap();
    assert_eq!(ruled.cli.as_deref(), Some("cursor"));
    assert_eq!(ruled.cli_from, "rule");
    assert_eq!(ruled.model.as_deref(), Some("composer"));
    assert_eq!(ruled.model_from, "rule");
    assert_eq!(ruled.effort.as_deref(), Some("high"));
    assert_eq!(ruled.effort_from, "rule");

    let mut skipped = query("", "", "", "", None, None, &signed);
    skipped.defaults = Some(RouteDefaults {
        mono: pick("cursor", "nope", "max"),
        project: pick("", "composer", "low"),
        system: pick("", "", "high"),
        usual: None,
    });
    skipped.catalog = stand_in_catalog();
    let skipped_route = store::route(&conn, &skipped, &[]).unwrap();
    assert_eq!(skipped_route.cli.as_deref(), Some("cursor"));
    assert_eq!(skipped_route.model.as_deref(), Some("composer"));
    assert_eq!(skipped_route.model_from, "project");
    assert_eq!(skipped_route.effort.as_deref(), Some("high"));
    assert_eq!(skipped_route.effort_from, "system");
    assert_eq!(
        skipped_route.skipped,
        vec![
            Skipped {
                field: "model".into(),
                from: "mono".into(),
                value: "nope".into(),
                reason: "Cursor doesn't offer \"nope\".".into(),
            },
            Skipped {
                field: "effort".into(),
                from: "mono".into(),
                value: "max".into(),
                reason: "Composer doesn't offer \"max\".".into(),
            },
            Skipped {
                field: "effort".into(),
                from: "project".into(),
                value: "low".into(),
                reason: "Composer doesn't offer \"low\".".into(),
            },
        ]
    );

    let mut huge = query(
        "",
        "",
        "",
        "",
        Some(Pick {
            cli: None,
            model: None,
            effort: Some("huge".into()),
        }),
        None,
        &signed,
    );
    huge.defaults = Some(RouteDefaults {
        mono: pick("claude", "claude:opus-4-7", "high"),
        project: None,
        system: None,
        usual: None,
    });
    huge.catalog = stand_in_catalog();
    let huge = store::route(&conn, &huge, &[]).unwrap();
    assert_eq!(huge.effort.as_deref(), Some("high"));
    assert_eq!(huge.effort_from, "mono");
    assert_eq!(huge.skipped[0].reason, "\"huge\" isn't an effort.");

    let mut quiet = query(
        "ui",
        "src/app",
        PROJECT,
        "",
        Some(Pick {
            cli: Some("nope".into()),
            model: None,
            effort: Some("huge".into()),
        }),
        None,
        &signed,
    );
    quiet.defaults = open.defaults.clone();
    let quiet = store::route(&conn, &quiet, &[]).unwrap();
    assert_eq!(quiet.cli.as_deref(), Some("cursor"));
    assert_eq!(quiet.effort.as_deref(), Some("high"));
    assert!(quiet.skipped.is_empty());

    let mut usual = query(
        "",
        "",
        "",
        "",
        None,
        None,
        &[("codex", true, true), ("claude", true, true)],
    );
    usual.defaults = Some(RouteDefaults {
        mono: None,
        project: None,
        system: None,
        usual: pick("", "claude:sonnet-5", "medium"),
    });
    usual.catalog = stand_in_catalog();
    let usual = store::route(&conn, &usual, &[]).unwrap();
    assert_eq!(usual.cli.as_deref(), Some("claude"));
    assert_eq!(usual.cli_from, "default");
    assert_eq!(usual.model.as_deref(), Some("claude:sonnet-5"));
    assert_eq!(usual.model_from, "default");
    assert_eq!(usual.effort.as_deref(), Some("medium"));
    assert_eq!(usual.effort_from, "default");

    let mut custom = query(
        "deep",
        "",
        "",
        "",
        Some(Pick {
            cli: None,
            model: Some("custom:deepseek-test".into()),
            effort: None,
        }),
        None,
        &signed,
    );
    custom.defaults = Some(RouteDefaults {
        mono: None,
        project: None,
        system: None,
        usual: pick("", "claude:sonnet-5", "medium"),
    });
    custom.catalog = stand_in_catalog();
    let custom = store::route(&conn, &custom, &[]).unwrap();
    assert_eq!(custom.model.as_deref(), Some("custom:deepseek-test"));
    assert_eq!(custom.model_from, "override");
    assert!(custom.skipped.iter().all(|row| row.field != "model"));

    let mut other = query(
        "",
        "",
        "",
        "",
        Some(Pick {
            cli: Some("cursor".into()),
            model: Some("custom:deepseek-test".into()),
            effort: None,
        }),
        None,
        &signed,
    );
    other.catalog = stand_in_catalog();
    other.defaults = Some(RouteDefaults {
        mono: None,
        project: None,
        system: None,
        usual: pick("", "composer", "medium"),
    });
    let other = store::route(&conn, &other, &[]).unwrap();
    assert_ne!(other.model.as_deref(), Some("custom:deepseek-test"));
    assert!(other
        .skipped
        .iter()
        .any(|row| row.value == "custom:deepseek-test"));
}

#[test]
fn a_mono_rule_beats_the_project_which_beats_a_plugin() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    save(
        &mut conn,
        "mono",
        "lead-1",
        vec![draft("ui", "", "codex", "", "")],
        0,
        None,
    )
    .unwrap();
    save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("ui", "", "cursor", "", "")],
        0,
        None,
    )
    .unwrap();
    let plugin = rules::from_plugin(
        crate::plugins::hivra::CrewRule {
            labels: vec!["ui".into()],
            paths: vec![],
            cli: Some("claude".into()),
            model: None,
            effort: None,
        },
        "zeta",
    );
    let mono = store::route(
        &conn,
        &query("ui", "", PROJECT, "lead-1", None, None, &[]),
        std::slice::from_ref(&plugin),
    )
    .unwrap();
    assert_eq!(mono.cli.as_deref(), Some("codex"));
    let project = store::route(
        &conn,
        &query("ui", "", PROJECT, "", None, None, &[]),
        std::slice::from_ref(&plugin),
    )
    .unwrap();
    assert_eq!(project.cli.as_deref(), Some("cursor"));
    let only_plugin = store::route(
        &conn,
        &query("ui", "", "/other/project", "", None, None, &[]),
        std::slice::from_ref(&plugin),
    )
    .unwrap();
    assert_eq!(only_plugin.cli.as_deref(), Some("claude"));
}

#[test]
fn a_design_monos_stored_rule_beats_the_project_for_the_same_task() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("screen", "", "claude", "", "")],
        0,
        None,
    )
    .unwrap();
    let mut asked = query("screen", "", PROJECT, "design", None, None, &[]);
    asked.mono_rules = vec![Rule {
        labels: vec!["screen".into()],
        paths: vec![],
        cli: Some("codex".into()),
        model: None,
        effort: None,
        task_ceiling_micros: None,
        source: "person".into(),
    }];
    let design = store::route(&conn, &asked, &[]).unwrap();
    assert_eq!(design.cli.as_deref(), Some("codex"));
    let project = store::route(
        &conn,
        &query("screen", "", PROJECT, "design", None, None, &[]),
        &[],
    )
    .unwrap();
    assert_eq!(project.cli.as_deref(), Some("claude"));
}

#[test]
fn a_plugin_file_is_read_and_a_broken_one_is_skipped() {
    let root = std::env::temp_dir().join(format!("hivra-wp13-crew-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("hivra")).unwrap();
    std::fs::write(
        root.join("hivra").join("crew-rules.json"),
        r#"{"rules":[{"match":{"labels":["docs"],"paths":[]},"cli":"cursor"},{"match":{"labels":[]},"nope":true}]}"#,
    )
    .unwrap();
    // `within` compares canonical paths. macOS temp is a symlink (`/var` → `/private/var`).
    let root = crate::fs::canonical(&root).unwrap();
    let mut reports = Vec::new();
    let loaded = crate::plugins::hivra::load(&root, &mut reports);
    assert_eq!(loaded.crew_rules.len(), 1);
    assert_eq!(loaded.crew_rules[0].cli.as_deref(), Some("cursor"));
    assert!(!reports.is_empty());
    let temp = crate::fs::canonical(std::env::temp_dir()).unwrap();
    assert!(root.starts_with(&temp) && root != temp);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_stale_save_is_refused_and_a_broken_stored_rule_is_skipped() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let first = save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("docs", "", "cursor", "", "")],
        0,
        None,
    )
    .unwrap();
    assert_eq!(first.revision, 1);
    let stale = save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("backend", "", "codex", "", "")],
        0,
        None,
    )
    .unwrap_err();
    assert_eq!(
        stale,
        "Someone else saved these rules. Reload and try again."
    );
    assert_eq!(
        store::get_rules(&conn, "project", PROJECT).unwrap().rules[0]
            .cli
            .as_deref(),
        Some("cursor")
    );
    conn.execute(
        "INSERT INTO crew_rules (scope, scope_id, position, labels, paths, cli, model, effort) VALUES ('project', ?1, 1, 'not-json', '[]', 'codex', NULL, NULL)",
        params![crate::delivery::settings::key(PROJECT)],
    )
    .unwrap();
    let kept = store::get_rules(&conn, "project", PROJECT).unwrap();
    assert_eq!(kept.rules.len(), 1);
    let too_many = vec![draft("docs", "", "cursor", "", ""); 41];
    assert!(save(
        &mut conn,
        "project",
        "/no/such/other project",
        too_many,
        0,
        None
    )
    .is_err());
    assert!(save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("docs", "", "cursor", "", "")],
        1,
        Some(&json!(true))
    )
    .is_err());
    assert!(save(
        &mut conn,
        "mono",
        "../lead",
        vec![draft("docs", "", "cursor", "", "")],
        0,
        None
    )
    .is_err());
}

#[test]
fn a_task_ceiling_is_stored_and_a_bad_one_is_refused() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let mut row = draft("ui", "", "cursor", "", "");
    row.task_ceiling_usd = Some(12.4);
    let saved = save(&mut conn, "project", PROJECT, vec![row], 0, None).unwrap();
    assert_eq!(saved.rules[0].task_ceiling_micros, Some(12_400_000));
    let json = serde_json::to_value(&saved.rules[0]).unwrap();
    assert_eq!(json["taskCeilingUsd"], json!(12.4));
    assert!(json.get("taskCeilingMicros").is_none());

    let mut bad = draft("ui", "", "cursor", "", "");
    bad.task_ceiling_usd = Some(0.0);
    let err = save(
        &mut conn,
        "project",
        PROJECT,
        vec![bad],
        saved.revision,
        None,
    )
    .unwrap_err();
    assert_eq!(err, "The task ceiling has to be a positive amount.");
    assert_eq!(
        store::get_rules(&conn, "project", PROJECT).unwrap().rules[0].task_ceiling_micros,
        Some(12_400_000)
    );

    let mut only = draft("ui", "", "", "", "");
    only.task_ceiling_usd = Some(10.0);
    let err = save(
        &mut conn,
        "project",
        PROJECT,
        vec![only],
        saved.revision,
        None,
    )
    .unwrap_err();
    assert!(err.contains("cli") || err.contains("picks nothing"), "{err}");
    assert!(!err.contains("taskCeiling"));

    let plugin = crate::plugins::hivra::check_crew_rule(&json!({
        "match": {"labels": ["docs"], "paths": []},
        "cli": "cursor",
        "taskCeilingUsd": 10
    }))
    .unwrap_err();
    assert!(plugin.contains("taskCeilingUsd"), "{plugin}");

    let old = Connection::open_in_memory().unwrap();
    old.execute_batch(
        "CREATE TABLE crew_rules (
           scope TEXT NOT NULL,
           scope_id TEXT NOT NULL,
           position INTEGER NOT NULL,
           labels TEXT NOT NULL,
           paths TEXT NOT NULL,
           cli TEXT,
           model TEXT,
           effort TEXT,
           PRIMARY KEY (scope, scope_id, position)
         );",
    )
    .unwrap();
    store::ensure_tables(&old).unwrap();
    store::ensure_tables(&old).unwrap();
    let kept = save(
        &mut old,
        "project",
        PROJECT,
        vec![draft("docs", "", "codex", "", "")],
        0,
        None,
    )
    .unwrap();
    assert_eq!(kept.rules[0].task_ceiling_micros, None);
    old.execute(
        "UPDATE crew_rules SET task_ceiling_usd = -1 WHERE position = 0",
        [],
    )
    .unwrap();
    assert!(store::get_rules(&old, "project", PROJECT).unwrap().rules.is_empty());

    let good: Rule = serde_json::from_value(json!({
        "labels": ["ui"],
        "paths": [],
        "cli": "codex",
        "taskCeilingUsd": 4,
        "source": "person"
    }))
    .unwrap();
    assert_eq!(good.task_ceiling_micros, Some(4_000_000));
    let mut asked = query("ui", "", PROJECT, "design", None, None, &[]);
    asked.mono_rules = vec![good];
    let won = store::route(&conn, &asked, &[]).unwrap();
    assert_eq!(won.cli.as_deref(), Some("codex"));

    let refused: Rule = serde_json::from_value(json!({
        "labels": ["ui"],
        "paths": [],
        "cli": "codex",
        "taskCeilingUsd": 0,
        "source": "person"
    }))
    .unwrap();
    assert_eq!(refused.task_ceiling_micros, Some(i64::MIN));
    asked.mono_rules = vec![refused];
    let fell = store::route(&conn, &asked, &[]).unwrap();
    assert_eq!(fell.cli.as_deref(), Some("cursor"));
}

#[test]
fn account_failures_move_and_the_work_itself_does_not() {
    for class in [
        "quota",
        "billing",
        "billing_or_quota",
        "rate_limit",
        "auth",
        "not_authenticated",
        "missing_cli",
        "credit",
        "sdk_not_installed",
    ] {
        assert_eq!(
            failure::failure_kind(Some(class), None),
            Kind::Account,
            "{class}"
        );
    }
    for class in [
        "model_unavailable",
        "approval_denied",
        "sandbox_denied",
        "permission_denied",
        "forbidden",
        "silent",
        "unknown",
        "",
    ] {
        assert_eq!(
            failure::failure_kind(Some(class), None),
            Kind::Task,
            "{class}"
        );
    }
    assert_eq!(failure::failure_kind(Some("timeout"), None), Kind::Again);
    assert_eq!(
        failure::failure_kind(Some("network_error"), None),
        Kind::Again
    );
    assert_eq!(failure::failure_kind(Some("overloaded"), None), Kind::Again);
    assert_eq!(
        failure::failure_kind(Some("provider_error"), None),
        Kind::Again
    );
    assert_eq!(
        failure::failure_kind(Some("provider_error"), Some("quota exceeded")),
        Kind::Account
    );
    assert_eq!(
        failure::failure_kind(Some(""), Some("timed out talking to the api")),
        Kind::Again
    );
    assert_eq!(
        failure::failure_kind(Some("usage_limit"), None),
        Kind::Usage
    );
    assert_eq!(
        failure::failure_kind(Some("not authenticated"), None),
        Kind::Task
    );
}

#[test]
fn the_classifier_keeps_the_puppetmaster_edges() {
    let output = "File \"production_authority.py\", line 3, in login\n    return login()\n    at run (/app/index.js:401:17)\ncommand not found";
    assert_eq!(
        failure::classify_adapter_failure("codex", output),
        failure::MISSING_CLI
    );
    assert_eq!(
        failure::classify_adapter_failure("", "production_authority"),
        failure::UNKNOWN
    );
    assert_eq!(
        failure::classify_adapter_failure("", "authentication failed"),
        failure::NOT_AUTHENTICATED
    );
    assert_eq!(
        failure::classify_adapter_failure("", "error 401 from the api"),
        failure::NOT_AUTHENTICATED
    );
    assert_eq!(
        failure::classify_adapter_failure("", "x401y"),
        failure::UNKNOWN
    );
    assert_eq!(
        failure::classify_adapter_failure("", "status 429"),
        failure::RATE_LIMIT
    );
    assert_eq!(
        failure::classify_adapter_failure("", "room 4291"),
        failure::UNKNOWN
    );
    let stdout =
        "{\"result\":\"edited src/login.ts and hit a rate limit in the copy\"}\nquota exceeded";
    let text = failure::json_output_diagnostic(stdout, failure::claude_code_diagnosis);
    assert!(!text.contains("login"));
    assert_eq!(
        failure::classify_adapter_failure("claude-code", &text),
        failure::BILLING_OR_QUOTA
    );
    assert_eq!(
        failure::classify_provider_failure("http_status:401", None, "blocked by upstream provider"),
        failure::SERVER_ERROR
    );
    assert_eq!(
        failure::classify_provider_failure("http_status:402", None, ""),
        failure::BILLING_OR_QUOTA
    );
    assert_eq!(
        failure::classify_openai_failure("nope", Some(500)),
        failure::OPENAI_SERVER_ERROR
    );
    let fx = json!({ "error": "MissingCredentials" });
    assert_eq!(
        failure::classify_fx_failure("", Some(&fx)),
        Some(failure::NOT_AUTHENTICATED)
    );
    assert!(
        failure::hermes_diagnostic("the answer mentions login", "boom\nsession_id: abc\n")
            .starts_with("boom")
    );
}

#[test]
fn the_budget_rejects_a_boolean_and_falls_back_when_garbage_is_already_stored() {
    assert!(normalize_failure_policy(&json!(true)).is_err());
    assert!(normalize_failure_policy(&json!(1.5)).is_err());
    assert!(normalize_failure_policy(&json!(11)).is_err());
    assert!(normalize_failure_policy(&json!("retry(11)")).is_err());
    assert!(normalize_failure_policy(&json!({"action":"retry","extra":1})).is_err());
    assert!(normalize_failure_policy(&json!({"action":"abort","retries":2})).is_err());
    assert_eq!(normalize_failure_policy(&json!(0)).unwrap().retries, 0);
    assert_eq!(
        normalize_failure_policy(&json!("retry(2)"))
            .unwrap()
            .retries,
        2
    );
    assert_eq!(
        normalize_failure_policy(&json!("abort")).unwrap().action,
        "abort"
    );
    assert_eq!(budget_or_default(None), 2);
    assert_eq!(budget_or_default(Some(&json!(true))), 2);
    assert_eq!(budget_or_default(Some(&json!("abort"))), 0);
    assert_eq!(budget_or_default(Some(&json!("continue"))), 2);
    assert_eq!(budget_or_default(Some(&json!("retry(11)"))), 2);
    assert_eq!(budget_or_default(Some(&json!(0))), 0);
}

#[test]
fn a_usage_limit_is_noted_while_the_row_stays_open() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let row = running_row(&mut conn, "worker-open-limit", "req-open-limit");
    let noted = store::note_pause(
        &mut conn,
        &pause_input(&row.id, Some(5_000), "claude"),
        1_200,
    )
    .unwrap();
    assert!(noted.applied);
    assert_eq!(noted.action, "pause");
    assert_eq!(noted.until, Some(5_000));
    let stayed = delegations::get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(stayed.state, "running");
    assert_eq!(stayed.generation, row.generation);
    assert_eq!(outcomes(&conn, &row.id), vec!["paused".to_string()]);
    let resume_at: i64 = conn
        .query_row(
            "SELECT resume_at FROM crew_holds WHERE delegation_id = ?1",
            [&row.id],
            |got| got.get(0),
        )
        .unwrap();
    assert_eq!(resume_at, 5_000);
    let stored: String = conn
        .query_row(
            "SELECT error_class || ' ' || outcome FROM crew_attempts WHERE delegation_id = ?1",
            [&row.id],
            |got| got.get(0),
        )
        .unwrap();
    assert_eq!(stored, "usage_limit paused");
    crate::watcher::tick(&mut conn, 5_000).unwrap();
    let after_tick = delegations::get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(after_tick.state, "running");
    assert_eq!(after_tick.generation, row.generation);
    let later = running_row(&mut conn, "worker-open-limit", "req-later-open");
    let first_before = delegations::get(&conn, &row.id).unwrap().unwrap();
    crate::watcher::tick(&mut conn, 5_000).unwrap();
    let later_now = delegations::get(&conn, &later.id).unwrap().unwrap();
    assert_eq!(later_now.state, later.state);
    assert_eq!(later_now.generation, later.generation);
    let first_after = delegations::get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(first_after.state, first_before.state);
    assert_eq!(first_after.generation, first_before.generation);
}

#[test]
fn a_cancelled_or_disposed_row_is_not_noted() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let running = running_row(&mut conn, "worker-stop", "req-stop");
    delegations::cancel(
        &mut conn,
        std::slice::from_ref(&running.id),
        Some("Stopped.".into()),
        None,
        1_100,
    )
    .unwrap();
    let cancelled = store::note_pause(
        &mut conn,
        &pause_input(&running.id, Some(5_000), "claude"),
        1_200,
    )
    .unwrap();
    assert!(!cancelled.applied);
    assert!(outcomes(&conn, &running.id).is_empty());
    assert_eq!(
        delegations::get(&conn, &running.id).unwrap().unwrap().state,
        "cancelled"
    );

    let open = running_row(&mut conn, "worker-dispose", "req-dispose");
    delegations::set_delivery(
        &mut conn,
        DeliveryInput {
            ids: vec![open.id.clone()],
            delivery: "disposed".into(),
            ..DeliveryInput::default()
        },
        1_100,
    )
    .unwrap();
    let disposed = store::note_pause(
        &mut conn,
        &pause_input(&open.id, Some(5_000), "claude"),
        1_200,
    )
    .unwrap();
    assert!(!disposed.applied);
    assert!(outcomes(&conn, &open.id).is_empty());
    let stayed = delegations::get(&conn, &open.id).unwrap().unwrap();
    assert_eq!(stayed.state, "running");
    assert_eq!(stayed.generation, open.generation);
}

/// A failed usage limit is noted, and the watcher does not flip that row, or a later one, back to running.
#[test]
fn a_paused_failure_is_not_reopened_by_the_watcher() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let paused = fail_row(
        &mut conn,
        "shared-running",
        Some("usage_limit"),
        Some(5_000),
    );
    let decision = store::on_failure(
        &mut conn,
        &failure(
            &paused.id,
            None,
            None,
            "claude",
            &[("claude", true, true)],
            None,
            None,
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(decision.action, "pause");
    assert!(decision.applied);
    let running = running_row(&mut conn, "shared-running", "req-later-running");
    crate::watcher::tick(&mut conn, 5_000).unwrap();
    let later = delegations::get(&conn, &running.id).unwrap().unwrap();
    assert_eq!(later.state, "running");
    assert_eq!(later.generation, running.generation);
    let stayed = delegations::get(&conn, &paused.id).unwrap().unwrap();
    assert_eq!(stayed.state, "failed");
    assert_eq!(stayed.generation, paused.generation);
    assert_eq!(outcomes(&conn, &paused.id), vec!["paused".to_string()]);
}

#[test]
fn settings_reports_the_signed_in_list_it_is_given() {
    let stored = store::StoredRules {
        rules: vec![],
        revision: 4,
        budget: None,
    };
    let view = super::response(
        stored,
        vec![],
        vec![Presence {
            cli: "claude".into(),
            installed: true,
            signed_in: true,
        }],
    );
    assert_eq!(view.revision, 4);
    assert_eq!(view.signed_in.len(), 1);
    assert_eq!(view.signed_in[0].cli, "claude");
    assert!(view.signed_in[0].installed);
    assert!(view.signed_in[0].signed_in);
}

#[test]
fn presence_keeps_installed_and_signed_in_apart_and_only_lists_crew_clis() {
    let rows = super::crew_presence(
        |cli| cli == "claude" || cli == "cursor",
        |cli| cli == "claude",
    );
    assert!(rows
        .iter()
        .all(|row| crate::plugins::hivra::CREW_CLIS.contains(&row.cli.as_str())));
    assert!(!rows.iter().any(|row| row.cli == "not-a-cli"));
    let claude = rows.iter().find(|row| row.cli == "claude").unwrap();
    assert!(claude.installed && claude.signed_in);
    let cursor = rows.iter().find(|row| row.cli == "cursor").unwrap();
    assert!(cursor.installed && !cursor.signed_in);
    let codex = rows.iter().find(|row| row.cli == "codex").unwrap();
    assert!(!codex.installed && !codex.signed_in);
}

#[test]
fn an_empty_presence_list_is_filled_and_a_given_one_is_kept() {
    let live = vec![Presence {
        cli: "claude".into(),
        installed: true,
        signed_in: true,
    }];
    let mut empty = Vec::new();
    super::fill_present(&mut empty, live.clone());
    assert_eq!(empty.len(), 1);
    assert!(empty[0].signed_in);
    let mut given = vec![Presence {
        cli: "codex".into(),
        installed: true,
        signed_in: false,
    }];
    super::fill_present(&mut given, live);
    assert_eq!(given.len(), 1);
    assert_eq!(given[0].cli, "codex");
    assert!(!given[0].signed_in);
}

#[test]
fn the_row_class_wins_and_a_timeout_is_not_the_work_failing() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let who = [("claude", true, true), ("codex", true, true)];
    let task = fail_row(&mut conn, "worker-task", Some("approval_denied"), None);
    let refused = store::on_failure(
        &mut conn,
        &failure(
            &task.id,
            Some("quota"),
            Some("sk-SECRET-value"),
            "claude",
            &who,
            None,
            None,
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(refused.action, "first-mate");
    assert_eq!(refused.reason, "the work failed");
    assert_eq!(hold_count(&conn, &task.id), 0);
    let class: String = conn
        .query_row(
            "SELECT error_class FROM crew_attempts WHERE delegation_id = ?1",
            [&task.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(class, "approval_denied");
    assert!(!class.contains("SECRET"));

    let quiet = fail_row(&mut conn, "worker-quiet", None, None);
    let moved = store::on_failure(
        &mut conn,
        &failure(
            &quiet.id,
            Some("sandbox_denied"),
            Some("quota sk-SECRET-value"),
            "claude",
            &who,
            None,
            None,
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(moved.action, "reroute");
    assert_eq!(moved.to.as_deref(), Some("codex"));
    let stored: String = conn
        .query_row("SELECT error_class || ' ' || IFNULL(model,'') || ' ' || IFNULL(to_cli,'') FROM crew_attempts WHERE delegation_id = ?1", [&quiet.id], |row| row.get(0))
        .unwrap();
    assert!(!stored.contains("SECRET"));

    let slow = fail_row(&mut conn, "worker-slow", Some("timeout"), None);
    let first = store::on_failure(
        &mut conn,
        &failure(&slow.id, None, None, "claude", &who, None, None),
        1_200,
    )
    .unwrap();
    let second = store::on_failure(
        &mut conn,
        &failure(&slow.id, None, None, "claude", &who, None, None),
        1_300,
    )
    .unwrap();
    let third = store::on_failure(
        &mut conn,
        &failure(&slow.id, None, None, "claude", &who, None, None),
        1_400,
    )
    .unwrap();
    assert_eq!(first.action, "again");
    assert_eq!(second.action, "again");
    assert_eq!(third.action, "first-mate");
    assert_eq!(third.reason, "the CLI didn't answer");
    assert_eq!(
        outcomes(&conn, &slow.id)
            .into_iter()
            .filter(|outcome| outcome == "again" || outcome == "rerouted")
            .count(),
        2
    );
}

#[test]
fn another_signed_in_cli_is_used_instead_of_waiting_and_the_budget_is_kept() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    save(&mut conn, "project", PROJECT, vec![], 0, Some(&json!(0))).unwrap();
    let capped = fail_row(&mut conn, "worker-cap", Some("quota"), Some(9_000));
    let stopped = store::on_failure(
        &mut conn,
        &failure(
            &capped.id,
            None,
            None,
            "claude",
            &[("claude", true, true), ("codex", true, true)],
            Some(PROJECT),
            None,
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(stopped.action, "first-mate");
    assert_eq!(stopped.reason, "the retry budget is spent");
    assert_eq!(hold_count(&conn, &capped.id), 0);

    let open = fail_row(&mut conn, "worker-open", Some("usage_limit"), Some(9_000));
    let moved = store::on_failure(
        &mut conn,
        &failure(
            &open.id,
            None,
            None,
            "claude",
            &[
                ("claude", true, true),
                ("cursor", true, false),
                ("codex", true, true),
            ],
            None,
            None,
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(moved.action, "reroute");
    assert_eq!(moved.to.as_deref(), Some("codex"));
    assert_eq!(hold_count(&conn, &open.id), 0);

    let past = fail_row(&mut conn, "worker-past", Some("usage_limit"), Some(500));
    let resumed = store::on_failure(
        &mut conn,
        &failure(
            &past.id,
            None,
            None,
            "claude",
            &[("claude", true, true)],
            None,
            None,
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(resumed.action, "resume");
    assert!(!resumed.applied);
    let stayed = delegations::get(&conn, &past.id).unwrap().unwrap();
    assert_eq!(stayed.state, "failed");
    assert_eq!(stayed.generation, 1);
    assert_eq!(hold_count(&conn, &past.id), 0);
    assert!(outcomes(&conn, &past.id).is_empty());
}

#[test]
fn a_destination_is_not_skipped_just_because_an_earlier_try_named_it() {
    let current = Pick {
        cli: Some("codex".into()),
        model: None,
        effort: None,
    };
    let who = present(&[
        ("claude", true, true),
        ("cursor", true, true),
        ("codex", true, true),
    ]);
    let ledger = vec![Attempt {
        at: 1,
        cli: Some("claude".into()),
        model: None,
        effort: None,
        error_class: "quota".into(),
        outcome: "rerouted".into(),
        to: Some("cursor".into()),
    }];
    let decision = decide(&FailureInput {
        error_class: Some("quota"),
        text: None,
        resets_at: None,
        now: 2,
        current: &current,
        present: &who,
        ledger: &ledger,
        budget: Some(&json!(2)),
    });
    assert_eq!(decision.action, "reroute");
    assert_eq!(decision.to.as_deref(), Some("cursor"));
}

/// An account failure names the next CLI. Nothing is relaunched, and that CLI is skipped for half an hour.
#[test]
fn a_route_skips_a_cli_that_failed_its_account_in_the_last_half_hour() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let now = 1_000_000;
    let who = &[("claude", true, true), ("codex", true, true)];
    let failed = fail_row(&mut conn, "worker-auth", Some("auth"), None);
    let moved = store::on_failure(
        &mut conn,
        &failure(&failed.id, None, None, "claude", who, None, None),
        now,
    )
    .unwrap();
    assert_eq!(moved.action, "reroute");
    assert_eq!(moved.to.as_deref(), Some("codex"));
    let stayed = delegations::get(&conn, &failed.id).unwrap().unwrap();
    assert_eq!(stayed.state, "failed");
    assert_eq!(stayed.generation, failed.generation);
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM delegations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);

    let minute = now + 60_000;
    let skipped =
        store::route_at(&conn, &query("", "", "", "", None, None, who), &[], minute).unwrap();
    assert_eq!(skipped.cli.as_deref(), Some("codex"));
    assert_eq!(skipped.cli_from, "default");

    save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("ui", "", "claude", "", "")],
        0,
        None,
    )
    .unwrap();
    let ruled = store::route_at(
        &conn,
        &query("ui", "", PROJECT, "", None, None, who),
        &[],
        minute,
    )
    .unwrap();
    assert_ne!(ruled.cli.as_deref(), Some("claude"));
    assert_eq!(ruled.cli.as_deref(), Some("codex"));

    let over = store::route_at(
        &conn,
        &query(
            "ui",
            "",
            PROJECT,
            "",
            Some(Pick {
                cli: Some("claude".into()),
                model: None,
                effort: None,
            }),
            None,
            who,
        ),
        &[],
        minute,
    )
    .unwrap();
    assert_eq!(over.cli.as_deref(), Some("claude"));
    assert_eq!(over.cli_from, "override");

    let cooled_off = now + 31 * 60 * 1000;
    let again = store::route_at(
        &conn,
        &query("", "", "", "", None, None, who),
        &[],
        cooled_off,
    )
    .unwrap();
    assert_eq!(again.cli.as_deref(), Some("claude"));
    assert_eq!(again.cli_from, "default");

    let task_store = memory();
    let mut task = task_store.lock_conn().unwrap();
    let denied = fail_row(&mut task, "worker-denied", Some("approval_denied"), None);
    let told = store::on_failure(
        &mut task,
        &failure(&denied.id, None, None, "claude", who, None, None),
        now,
    )
    .unwrap();
    assert_eq!(told.action, "first-mate");
    let still =
        store::route_at(&task, &query("", "", "", "", None, None, who), &[], minute).unwrap();
    assert_eq!(still.cli.as_deref(), Some("claude"));

    let pause_store = memory();
    let mut pause = pause_store.lock_conn().unwrap();
    let open = running_row(&mut pause, "worker-limit", "req-limit");
    store::note_pause(
        &mut pause,
        &pause_input(&open.id, Some(now + 9_000), "claude"),
        now,
    )
    .unwrap();
    let kept =
        store::route_at(&pause, &query("", "", "", "", None, None, who), &[], minute).unwrap();
    assert_eq!(kept.cli.as_deref(), Some("claude"));
}
