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
        policy: json!({ "lockDefault": false, "neverUse": [], "fallback": [] }),
        policy_own: true,
        policy_unreadable: false,
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
    assert_eq!(stopped.reason, "The retry budget is spent");
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
        policy: None,
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

#[test]
fn a_policy_round_trips_and_a_stale_save_does_not_write() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let first = store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({
            "lockDefault": true,
            "neverUse": ["codex", "codex", "../ada", "ada", "nope\ncli", "C:\\mono"],
            "fallback": ["grok", "nope", "claude", "grok"]
        }),
        0,
    )
    .unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(first.policy["lockDefault"], true);
    assert_eq!(first.policy["neverUse"], json!(["codex", "ada"]));
    assert_eq!(first.policy["fallback"], json!(["grok", "claude"]));
    let stale = store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": false }),
        0,
    );
    assert!(stale.unwrap_err().contains("Reload"));
    let kept = store::get_rules(&conn, "system", "system").unwrap();
    assert_eq!(kept.policy["lockDefault"], true);
    let saved = save(&mut conn, "system", "system", vec![], 1, None).unwrap();
    assert_eq!(saved.revision, 2);
    assert_eq!(saved.policy["neverUse"], json!(["codex", "ada"]));
    let project = store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": false, "neverUse": ["pi"], "fallback": [] }),
        0,
    )
    .unwrap();
    assert_eq!(project.policy["neverUse"], json!(["pi"]));
    assert!(store::set_policy(&mut conn, "system", "other", &json!({}), 0).is_err());
}

#[test]
fn a_project_with_no_policy_of_its_own_shows_the_system_one_until_it_saves_its_own() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    // Saving roles creates the project's row, but no policy of its own.
    save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("builder", "", "grok", "", "")],
        0,
        None,
    )
    .unwrap();
    let inherited = store::get_rules(&conn, "project", PROJECT).unwrap();
    assert!(!inherited.policy_own);
    assert_eq!(inherited.policy["neverUse"], json!(["codex"]));
    let own = store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        inherited.revision,
    )
    .unwrap();
    assert!(own.policy_own);
    assert_eq!(own.policy["lockDefault"], true);
    assert!(
        store::get_rules(&conn, "system", "system")
            .unwrap()
            .policy_own
    );
}

#[test]
fn the_default_skips_a_cli_on_never_use_as_well_as_a_cooled_one() {
    let signed = present(&[
        ("claude", true, true),
        ("codex", true, true),
        ("grok", true, true),
    ]);
    // Claude is cooling after its account failed, and Codex is on Never use: only Grok can take the work.
    assert_eq!(
        super::resolve::default_cli_except(&signed, &["claude".into()], &["codex".into()])
            .as_deref(),
        Some("grok"),
    );
    // Never use alone also keeps the default off the banned CLI, Claude first as usual.
    assert_eq!(
        super::resolve::default_cli_except(&signed, &[], &["claude".into()]).as_deref(),
        Some("codex"),
    );
}

fn pick_cli(cli: &str, model: &str, effort: &str) -> Pick {
    Pick {
        cli: some(cli),
        model: some(model),
        effort: some(effort),
    }
}

/// Never use skips the named CLI. A role label is an ordinary rule. The lock drops an override, not the brief.
#[test]
fn never_use_skips_a_named_cli_and_a_role_label_is_a_rule() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let who = &[
        ("claude", true, true),
        ("codex", true, true),
        ("cursor", true, true),
    ];
    save(
        &mut conn,
        "project",
        PROJECT,
        vec![
            draft("builder", "", "codex", "gpt-codex", "high"),
            draft("reviewer", "", "cursor", "", ""),
        ],
        0,
        None,
    )
    .unwrap();
    let built = store::route(
        &conn,
        &query("builder", "", PROJECT, "", None, None, who),
        &[],
    )
    .unwrap();
    assert_eq!(built.cli.as_deref(), Some("codex"));
    assert_eq!(built.cli_from, "rule");
    assert_eq!(built.model.as_deref(), Some("gpt-codex"));
    // WP-141: the matched rule's label goes back, so the row can say "Builder role prefers Codex."
    assert_eq!(built.rule_label.as_deref(), Some("builder"));
    assert_eq!(
        serde_json::to_value(&built).unwrap()["ruleLabel"],
        serde_json::json!("builder")
    );
    let other = store::route(
        &conn,
        &query("reviewer", "", PROJECT, "", None, None, who),
        &[],
    )
    .unwrap();
    assert_eq!(other.cli.as_deref(), Some("cursor"));

    let over = store::route(
        &conn,
        &query(
            "builder",
            "",
            PROJECT,
            "",
            Some(pick_cli("claude", "opus", "")),
            None,
            who,
        ),
        &[],
    )
    .unwrap();
    assert_eq!(over.cli.as_deref(), Some("claude"));
    assert_eq!(over.cli_from, "override");
    assert_eq!(over.model.as_deref(), Some("opus"));
    assert!(over.skipped.is_empty());

    store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        1,
    )
    .unwrap();
    let banned = store::route(
        &conn,
        &query("builder", "", PROJECT, "", None, None, who),
        &[],
    )
    .unwrap();
    assert_eq!(banned.cli.as_deref(), Some("claude"));
    assert_eq!(banned.cli_from, "default");
    assert_eq!(banned.model, None);
    assert_eq!(banned.effort, None);
    assert_eq!(banned.skipped.len(), 1);
    assert_eq!(banned.skipped[0].from, "rule");
    assert_eq!(banned.skipped[0].value, "codex");
    assert_eq!(
        banned.skipped[0].reason,
        "Codex is on Never use, so it was skipped."
    );

    let through = store::route(
        &conn,
        &query(
            "builder",
            "",
            PROJECT,
            "",
            Some(pick_cli("codex", "from-override", "max")),
            Some(pick_cli("cursor", "from-brief", "")),
            who,
        ),
        &[],
    )
    .unwrap();
    assert_eq!(through.cli.as_deref(), Some("cursor"));
    assert_eq!(through.cli_from, "brief");
    assert_eq!(through.model.as_deref(), Some("from-brief"));
    assert_eq!(through.effort, None);

    // Ada has no saved policy, so the project's Never use still applies.
    let borrowed = store::route(
        &conn,
        &query("builder", "", PROJECT, "ada", None, None, who),
        &[],
    )
    .unwrap();
    assert_eq!(borrowed.cli.as_deref(), Some("claude"));
    assert_eq!(borrowed.cli_from, "default");
    assert_eq!(borrowed.skipped.len(), 1);
    assert_eq!(borrowed.skipped[0].value, "codex");

    store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        2,
    )
    .unwrap();
    let locked = store::route(
        &conn,
        &query(
            "builder",
            "",
            PROJECT,
            "",
            Some(pick_cli("grok", "big", "max")),
            Some(pick_cli("cursor", "", "")),
            who,
        ),
        &[],
    )
    .unwrap();
    assert_eq!(locked.cli.as_deref(), Some("cursor"));
    assert_eq!(locked.cli_from, "brief");
    assert_eq!(locked.model.as_deref(), Some("gpt-codex"));
    assert_eq!(locked.effort.as_deref(), Some("high"));
    assert_eq!(
        locked.skipped[0].reason,
        "Always use my default is on, so this override was not applied."
    );

    let fresh = memory();
    let mut bare = fresh.lock_conn().unwrap();
    store::set_policy(
        &mut bare,
        "system",
        "system",
        &json!({ "lockDefault": false, "neverUse": ["claude"], "fallback": [] }),
        0,
    )
    .unwrap();
    let fell = store::route(&bare, &query("", "", "", "", None, None, who), &[]).unwrap();
    assert_eq!(fell.cli.as_deref(), Some("codex"));
    assert_eq!(fell.skipped[0].from, "default");
    assert_eq!(fell.skipped[0].value, "claude");
    assert_eq!(
        fell.skipped[0].reason,
        "Claude Code is on Never use, so it was skipped."
    );
}

/// A cooled CLI stays put while Always use my default is on. The usual swap still runs with no policy.
#[test]
fn a_lock_keeps_a_cooled_cli() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let now = 1_000_000;
    let who = &[("claude", true, true), ("codex", true, true)];
    let failed = fail_row(&mut conn, "worker-lock", Some("auth"), None);
    store::on_failure(
        &mut conn,
        &failure(&failed.id, None, None, "claude", who, None, None),
        now,
    )
    .unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        0,
    )
    .unwrap();
    let stayed = store::route_at(
        &conn,
        &query("", "", "", "", None, None, who),
        &[],
        now + 60_000,
    )
    .unwrap();
    assert_eq!(stayed.cli.as_deref(), Some("claude"));
    assert_eq!(stayed.cli_from, "default");
    assert_eq!(
        stayed.skipped[0].reason,
        "Always use my default is on, so another CLI was not used."
    );
}

fn classes(conn: &Connection, id: &str) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare(
            "SELECT outcome, error_class FROM crew_attempts WHERE delegation_id = ?1 ORDER BY n",
        )
        .unwrap();
    statement
        .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
}

fn input<'a>(
    current: &'a Pick,
    who: &'a [Presence],
    class: &'a str,
    resets_at: Option<i64>,
    policy: Option<&'a Value>,
) -> FailureInput<'a> {
    FailureInput {
        error_class: Some(class),
        text: None,
        resets_at,
        now: 1_000,
        current,
        present: who,
        ledger: &[],
        budget: None,
        policy,
    }
}

/// The person's list replaces presence order. A ban, a signed-out CLI and a missing CLI are said, then stored.
#[test]
fn fallback_order_is_walked_and_a_ban_is_on_the_ledger() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({
            "lockDefault": false,
            "neverUse": ["codex"],
            "fallback": ["codex", "cursor", "pi", "grok", "nope\ncli"]
        }),
        0,
    )
    .unwrap();
    let row = fail_row(&mut conn, "worker-order", Some("quota"), None);
    let moved = store::on_failure(
        &mut conn,
        &failure(
            &row.id,
            None,
            None,
            "claude",
            &[
                ("claude", true, true),
                ("codex", true, true),
                ("cursor", true, false),
                ("grok", true, true),
            ],
            None,
            None,
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(moved.action, "reroute");
    assert_eq!(moved.to.as_deref(), Some("grok"));
    assert_eq!(
        moved.reason,
        "Codex is on Never use, so it was skipped. Cursor isn't signed in, so it was skipped. Pi isn't installed here, so it was skipped. Claude Code can't take it, so this uses Grok."
    );
    let rows = classes(&conn, &row.id);
    assert_eq!(rows[0].0, "skipped");
    assert_eq!(rows[0].1, "Codex is on Never use, so it was skipped.");
    assert_eq!(rows[1].1, "Cursor isn't signed in, so it was skipped.");
    assert_eq!(rows[2].1, "Pi isn't installed here, so it was skipped.");
    assert_eq!(rows[3].0, "rerouted");
    assert_eq!(rows.len(), 4);
}

/// A Mono id with no saved row uses the system policy. Project beats system. The Mono's own row still wins.
#[test]
fn a_mono_with_no_saved_policy_uses_the_system_policy() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let who = &[
        ("claude", true, true),
        ("codex", true, true),
        ("grok", true, true),
    ];
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": false, "neverUse": ["claude"], "fallback": ["grok"] }),
        0,
    )
    .unwrap();
    let routed = store::route(&conn, &query("", "", "", "ada", None, None, who), &[]).unwrap();
    assert_eq!(routed.cli.as_deref(), Some("codex"));
    assert_eq!(routed.skipped[0].value, "claude");
    assert_eq!(
        routed.skipped[0].reason,
        "Claude Code is on Never use, so it was skipped."
    );

    let row = fail_row(&mut conn, "worker-system-mono", Some("quota"), None);
    let moved = store::on_failure(
        &mut conn,
        &failure(&row.id, None, None, "codex", who, None, Some("ada")),
        1_200,
    )
    .unwrap();
    assert_eq!(moved.to.as_deref(), Some("grok"));

    store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": true, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let project = store::route(
        &conn,
        &query(
            "",
            "",
            PROJECT,
            "ada",
            Some(pick_cli("grok", "", "")),
            None,
            who,
        ),
        &[],
    )
    .unwrap();
    // WP-141 MEDIUM 6: the system's Never use (claude) still holds in the project, so the default walks to grok.
    assert_eq!(project.cli.as_deref(), Some("grok"));
    assert_eq!(project.cli_from, "default");
    assert!(project
        .skipped
        .iter()
        .any(|skip| skip.value == "grok" && skip.from == "override"));

    store::set_policy(
        &mut conn,
        "mono",
        "ada",
        &json!({ "lockDefault": false, "neverUse": [], "fallback": ["codex"] }),
        0,
    )
    .unwrap();
    let own = fail_row(&mut conn, "worker-mono-own-policy", Some("quota"), None);
    let used = store::on_failure(
        &mut conn,
        &failure(
            &own.id,
            None,
            None,
            "claude",
            who,
            Some(PROJECT),
            Some("ada"),
        ),
        1_200,
    )
    .unwrap();
    // WP-141 MEDIUM 6: the project's lock is on for this Mono too, and codex is on the project's Never use. The failure
    // pauses for the first mate; nothing moves to another CLI silently.
    assert_eq!(used.to, None);
}

/// A Mono with no saved policy takes the project's list. Its own list replaces that.
#[test]
fn a_mono_with_no_policy_uses_the_project_fallback() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": false, "neverUse": [], "fallback": ["grok"] }),
        0,
    )
    .unwrap();
    let who = &[
        ("claude", true, true),
        ("codex", true, true),
        ("grok", true, true),
    ];
    let row = fail_row(&mut conn, "worker-mono", Some("quota"), None);
    let borrowed = store::on_failure(
        &mut conn,
        &failure(
            &row.id,
            None,
            None,
            "claude",
            who,
            Some(PROJECT),
            Some("ada"),
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(borrowed.to.as_deref(), Some("grok"));
    assert_eq!(
        borrowed.reason,
        "Claude Code can't take it, so this uses Grok."
    );
    store::set_policy(
        &mut conn,
        "mono",
        "ada",
        &json!({ "lockDefault": false, "neverUse": [], "fallback": ["codex"] }),
        0,
    )
    .unwrap();
    let own = fail_row(&mut conn, "worker-mono-own", Some("quota"), None);
    let used = store::on_failure(
        &mut conn,
        &failure(
            &own.id,
            None,
            None,
            "claude",
            who,
            Some(PROJECT),
            Some("ada"),
        ),
        1_200,
    )
    .unwrap();
    assert_eq!(used.to.as_deref(), Some("codex"));
    assert_eq!(
        used.reason,
        "Claude Code can't take it, so this uses Codex."
    );
}

/// The lock does not switch. A known reset waits. No reset wakes the first mate. One CLI still waits as before.
#[test]
fn a_lock_pauses_on_a_reset_and_wakes_the_first_mate() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": ["codex"] }),
        0,
    )
    .unwrap();
    let who = &[("claude", true, true), ("codex", true, true)];
    let waiting = fail_row(&mut conn, "worker-wait", Some("quota"), Some(9_000));
    let paused = store::on_failure(
        &mut conn,
        &failure(&waiting.id, None, None, "claude", who, None, None),
        1_200,
    )
    .unwrap();
    assert_eq!(paused.action, "pause");
    assert_eq!(paused.to, None);
    assert_eq!(paused.until, Some(9_000));
    assert_eq!(
        paused.reason,
        "Always use my default is on, so another CLI was not used."
    );
    assert_eq!(hold_count(&conn, &waiting.id), 1);
    assert_eq!(outcomes(&conn, &waiting.id), vec!["paused".to_string()]);

    let stuck = fail_row(&mut conn, "worker-wake", Some("quota"), None);
    let woken = store::on_failure(
        &mut conn,
        &failure(&stuck.id, None, None, "claude", who, None, None),
        1_200,
    )
    .unwrap();
    assert_eq!(woken.action, "first-mate");
    assert_eq!(woken.to, None);
    assert_eq!(
        woken.reason,
        "Always use my default is on, so another CLI was not used."
    );
    assert_eq!(hold_count(&conn, &stuck.id), 0);

    let current = Pick {
        cli: Some("claude".into()),
        model: None,
        effort: None,
    };
    let alone = present(&[("claude", true, true)]);
    let still = decide(&input(
        &current,
        &alone,
        "usage_limit",
        Some(5_000),
        Some(&json!({ "lockDefault": true })),
    ));
    assert_eq!(still.action, "pause");
    assert_eq!(still.reason, "Waiting for a usage limit to reset");
    let due = decide(&input(
        &current,
        &present(who),
        "usage_limit",
        Some(1_000),
        Some(&json!({ "lockDefault": true })),
    ));
    assert_eq!(due.action, "resume");
    assert_eq!(due.reason, "The usage limit has reset");
    let off = decide(&input(
        &current,
        &present(who),
        "quota",
        None,
        Some(&json!({ "fallback": ["grok"] })),
    ));
    assert_eq!(off.action, "first-mate");
    assert_eq!(
        off.reason,
        "Grok isn't installed here, so it was skipped. No other worker can take it"
    );
    let banned = decide(&input(
        &current,
        &present(&[
            ("claude", true, true),
            ("codex", true, true),
            ("grok", true, true),
        ]),
        "quota",
        None,
        Some(&json!({ "neverUse": ["codex"] })),
    ));
    assert_eq!(banned.to.as_deref(), Some("grok"));
    assert_eq!(
        banned.reason,
        "Codex is on Never use, so it was skipped. Claude Code can't take it, so this uses Grok."
    );
    let itself = decide(&input(
        &current,
        &present(&[("claude", true, true), ("grok", true, true)]),
        "quota",
        None,
        Some(&json!({ "neverUse": ["claude"] })),
    ));
    assert_eq!(
        itself.reason,
        "Claude Code is on Never use, so it was skipped. Claude Code can't take it, so this uses Grok."
    );
    let held = vec![itself.skipped[0].clone()];
    let repeated = decide(&FailureInput {
        error_class: Some("quota"),
        text: None,
        resets_at: None,
        now: 1_000,
        current: &current,
        present: &present(&[("claude", true, true), ("grok", true, true)]),
        ledger: &held,
        budget: None,
        policy: Some(&json!({ "neverUse": ["claude"] })),
    });
    // A recorded skip is not an attempt, so a ban that is still there is said again.
    assert_eq!(repeated.to.as_deref(), Some("grok"));
    assert_eq!(repeated.skipped.len(), 1);
    assert_eq!(repeated.skipped[0].cli.as_deref(), Some("claude"));
    assert_eq!(repeated.skipped[0].outcome, "skipped");
    let again = decide(&input(
        &current,
        &present(who),
        "timeout",
        None,
        Some(&json!({ "lockDefault": true })),
    ));
    assert_eq!(again.action, "again");
    assert_eq!(again.reason, "the CLI didn't answer");
}

/// A skip is not an attempt. Signing in, or taking a CLI off Never use, offers it again. A real attempt does not.
#[test]
fn a_skipped_cli_is_offered_again_once_it_can_take_the_work() {
    let current = Pick {
        cli: Some("claude".into()),
        model: None,
        effort: None,
    };
    let skipped = Attempt {
        at: 1_000,
        cli: Some("codex".into()),
        model: None,
        effort: None,
        error_class: "Codex isn't signed in, so it was skipped.".into(),
        outcome: "skipped".into(),
        to: None,
    };
    let offered = decide(&FailureInput {
        error_class: Some("quota"),
        text: None,
        resets_at: None,
        now: 2_000,
        current: &current,
        present: &present(&[("claude", true, true), ("codex", true, true)]),
        ledger: std::slice::from_ref(&skipped),
        budget: None,
        policy: Some(&json!({ "fallback": ["codex"] })),
    });
    assert_eq!(offered.action, "reroute");
    assert_eq!(offered.to.as_deref(), Some("codex"));

    let mut tried = skipped;
    tried.outcome = "rerouted".into();
    let blocked = decide(&FailureInput {
        error_class: Some("quota"),
        text: None,
        resets_at: None,
        now: 2_000,
        current: &current,
        present: &present(&[("claude", true, true), ("codex", true, true)]),
        ledger: std::slice::from_ref(&tried),
        budget: None,
        policy: Some(&json!({ "fallback": ["codex"] })),
    });
    assert_ne!(blocked.to.as_deref(), Some("codex"));
}

#[test]
fn the_first_mates_pick_reads_the_stored_rules_policy_and_roster() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let who = &[("claude", true, true), ("codex", true, true)];
    save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("builder", "", "codex", "", "")],
        0,
        None,
    )
    .unwrap();
    let ask =
        |labels: &str, monos: Vec<store::PickMono>, mono_ask: Option<&str>| store::PickRequest {
            route: query(labels, "", PROJECT, "", None, None, who),
            monos,
            lead_mono_id: Some("lead".into()),
            depth: 0,
            at_cap: Vec::new(),
            mono_override: mono_ask.map(str::to_string),
        };
    let built = store::pick_at(&conn, &ask("builder", vec![], None), &[], i64::MAX).unwrap();
    assert!(built.ok);
    assert_eq!(built.cli.as_deref(), Some("codex"));
    assert_eq!(built.reason, "Builder role prefers Codex.");
    let ada = store::PickMono {
        id: "ada".into(),
        name: Some("Ada".into()),
        role: Some("reviewer".into()),
        depth: 0,
    };
    let review = store::pick_at(
        &conn,
        &ask("reviewer", vec![ada.clone()], None),
        &[],
        i64::MAX,
    )
    .unwrap();
    assert_eq!(review.mono_id.as_deref(), Some("ada"));
    assert_eq!(review.reason, "Ada fits the reviewer role.");
    let wire = serde_json::to_value(&review).unwrap();
    assert_eq!(wire["monoId"], json!("ada"));
    // The person's Never use, stored on the project, keeps that Mono and that CLI out.
    store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": false, "neverUse": ["ada", "codex"], "fallback": [] }),
        1,
    )
    .unwrap();
    let banned = store::pick_at(
        &conn,
        &ask("builder", vec![ada.clone()], Some("ada")),
        &[],
        i64::MAX,
    )
    .unwrap();
    assert_eq!(banned.cli.as_deref(), Some("claude"));
    assert_eq!(banned.mono_id, None);
    assert!(
        banned.reason.contains("on Never use, so it was skipped."),
        "{}",
        banned.reason
    );
    // Depth 3 refuses another Mono the first mate asks for.
    store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": false, "neverUse": [], "fallback": [] }),
        2,
    )
    .unwrap();
    let mut deep = ask("reviewer", vec![ada], Some("ada"));
    deep.depth = 3;
    let deep = store::pick_at(&conn, &deep, &[], i64::MAX).unwrap();
    assert!(!deep.ok);
    assert_eq!(
        deep.reason,
        "This chat is already three Monos deep, so another Mono was refused."
    );
}

/// A role row saved for everything (no project) still picks the CLI, including for a Mono, and the lock keeps that row.
#[test]
fn a_system_role_rule_reaches_a_mono_launch_and_the_lock_keeps_it() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let who = &[
        ("claude", true, true),
        ("codex", true, true),
        ("grok", true, true),
    ];
    save(
        &mut conn,
        "system",
        "system",
        vec![draft("builder", "", "codex", "", "")],
        0,
        None,
    )
    .unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        1,
    )
    .unwrap();
    let open = store::pick_at(
        &conn,
        &store::PickRequest {
            route: query("builder", "", "", "", None, None, who),
            monos: vec![],
            lead_mono_id: None,
            depth: 0,
            at_cap: vec![],
            mono_override: None,
        },
        &[],
        i64::MAX,
    )
    .unwrap();
    assert_eq!(open.cli.as_deref(), Some("codex"));
    assert_eq!(open.reason, "Builder role prefers Codex.");

    let locked = store::pick_at(
        &conn,
        &store::PickRequest {
            route: query(
                "builder",
                "",
                "",
                "ada",
                Some(pick_cli("grok", "", "")),
                None,
                who,
            ),
            monos: vec![],
            lead_mono_id: Some("ada".into()),
            depth: 0,
            at_cap: vec![],
            mono_override: None,
        },
        &[],
        i64::MAX,
    )
    .unwrap();
    assert_eq!(locked.cli.as_deref(), Some("codex"));
    assert_eq!(
        locked.reason,
        "Always use my default is on, so this override was not applied. Builder role prefers Codex."
    );

    save(
        &mut conn,
        "project",
        PROJECT,
        vec![draft("builder", "", "grok", "", "")],
        0,
        None,
    )
    .unwrap();
    let nearer = store::route(
        &conn,
        &query("builder", "", PROJECT, "ada", None, None, who),
        &[],
    )
    .unwrap();
    assert_eq!(nearer.cli.as_deref(), Some("grok"));
    assert_eq!(nearer.cli_from, "rule");
    assert_eq!(nearer.rule_label.as_deref(), Some("builder"));
}

/// WP-141: a typed CLI name ("Codex", "Claude Code") is stored as its id, so a Never use list matches it.
#[test]
fn a_typed_cli_name_is_stored_as_its_id() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let saved = store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": false, "neverUse": ["Codex", "Claude Code"], "fallback": ["Grok", "nope"] }),
        0,
    )
    .unwrap();
    assert_eq!(saved.policy["neverUse"], json!(["codex", "claude"]));
    assert_eq!(saved.policy["fallback"], json!(["grok"]));
    let who = &[
        ("claude", true, true),
        ("codex", true, true),
        ("grok", true, true),
    ];
    let routed = store::route(&conn, &query("", "", "", "ada", None, None, who), &[]).unwrap();
    assert_eq!(routed.cli.as_deref(), Some("grok"));
    assert_eq!(routed.never, vec!["codex", "claude"]);
}

/// WP-141 MEDIUM 6: a project's policy does not replace the system's. Never use is the union, and the lock is on when
/// any scope sets it.
#[test]
fn never_use_is_the_union_of_mono_project_and_system_and_the_lock_is_any_scope() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": ["claude"], "fallback": [] }),
        0,
    )
    .unwrap();
    store::set_policy(
        &mut conn,
        "project",
        PROJECT,
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let who = &[
        ("claude", true, true),
        ("codex", true, true),
        ("grok", true, true),
    ];
    let routed = store::route(&conn, &query("", "", PROJECT, "", None, None, who), &[]).unwrap();
    assert!(routed.lock, "the system lock reaches the project");
    assert!(routed.never.contains(&"claude".to_string()));
    assert!(routed.never.contains(&"codex".to_string()));
    assert_eq!(routed.cli.as_deref(), Some("grok"));
    // The Mono's own policy adds to the same union, and the gate sees the same list.
    store::set_policy(
        &mut conn,
        "mono",
        "ada",
        &json!({ "lockDefault": false, "neverUse": ["grok"], "fallback": [] }),
        0,
    )
    .unwrap();
    let monoed = store::route(&conn, &query("", "", PROJECT, "ada", None, None, who), &[]).unwrap();
    assert_eq!(monoed.never, vec!["grok", "codex", "claude"]);
    assert_eq!(monoed.cli, None);
    let check = |cli: &str, locked: Option<&str>| {
        super::gate::check_launch(
            &conn,
            &super::gate::LaunchCheck {
                cli: cli.into(),
                mono: Some("ada".into()),
                project: Some(PROJECT.into()),
                locked_default: locked.map(str::to_string),
            },
        )
    };
    assert!(
        (check("grok", Some("grok")).unwrap_err()).starts_with("Grok is on Never use for "),
        "unexpected refusal"
    );
    assert!(
        (check("claude", Some("claude")).unwrap_err())
            .starts_with("Claude Code is on Never use for "),
        "unexpected refusal"
    );
}

/// WP-141: the launch gate. A CLI on Never use is refused whatever routed it. Under the lock a launch must run on
/// the locked default. A policy that can't be read refuses, with a line that says so.
#[test]
fn the_launch_gate_refuses_a_banned_cli_an_off_default_launch_and_an_unreadable_policy() {
    use super::gate::{check_launch, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let check = |conn: &Connection, cli: &str, locked: Option<&str>| {
        check_launch(
            conn,
            &LaunchCheck {
                cli: cli.into(),
                mono: None,
                project: None,
                locked_default: locked.map(str::to_string),
            },
        )
    };
    // No policy: everything starts, as before.
    assert!(check(&conn, "codex", None).is_ok());
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    assert!(
        (check(&conn, "codex", Some("claude")).unwrap_err())
            .starts_with("Codex is on Never use for "),
        "unexpected refusal"
    );
    assert!(check(&conn, "claude", Some("claude")).is_ok());
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": ["codex"], "fallback": [] }),
        1,
    )
    .unwrap();
    assert_eq!(
        check(&conn, "grok", Some("claude")).unwrap_err(),
        "Always use my default is on, and the default is Claude Code, so Grok was not started. Change it in Settings > Crew Defaults."
    );
    assert!(check(&conn, "claude", Some("claude")).is_ok());
    assert!(check(&conn, "claude", None)
        .unwrap_err()
        .starts_with("Always use my default is on and no default CLI"));
    conn.execute_batch("DROP TABLE crew_rule_meta;").unwrap();
    let unreadable = check(&conn, "claude", Some("claude")).unwrap_err();
    assert!(
        unreadable.starts_with("The crew policy could not be read, so nothing was started"),
        "{unreadable}"
    );
}

/// WP-141: a route carries the Never use list and the lock, so the caller can check the launch against them.
#[test]
fn a_route_says_which_never_use_and_lock_it_was_chosen_under() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": ["grok"], "fallback": [] }),
        0,
    )
    .unwrap();
    let who = &[("claude", true, true), ("grok", true, true)];
    let routed = store::route(&conn, &query("", "", "", "", None, None, who), &[]).unwrap();
    assert!(routed.lock);
    assert_eq!(routed.never, vec!["grok"]);
    assert_eq!(routed.cli.as_deref(), Some("claude"));
}

/// WP-141 round 5 (HIGH-C/MEDIUM-F): the spawn gate. An agent session's process needs a one-time ticket from the gate,
/// bound to its session, CLI and folder, and a banned CLI gets none whichever path asked for it.
#[test]
fn a_spawn_needs_a_ticket_for_an_agent_session_and_none_for_ashs_own_chat() {
    use super::gate::require_ticket;
    let err = require_ticket("app-spawn-none-1", "claude", "/tmp/spawn-none", None).unwrap_err();
    assert!(err.contains("no crew gate ticket"), "{err}");
    assert!(require_ticket("3f2a9c1e-ashs-chat", "claude", "/tmp/spawn-none", None).is_ok());
}

#[test]
fn a_ticket_is_one_time_and_bound_to_its_session_cli_and_folder() {
    use super::gate::{issue_ticket, record_grant, require_ticket, LaunchCheck};
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let session = "app-ticket-bound-1";
    record_grant(
        &conn,
        session,
        &LaunchCheck {
            cli: "claude".into(),
            mono: None,
            project: Some("/tmp/ticket-bound".into()),
            locked_default: None,
        },
    )
    .unwrap();
    let wrong_cli = issue_ticket(&conn, session, "claude", "/tmp/ticket-bound").unwrap();
    let err = require_ticket(session, "codex", "/tmp/ticket-bound", Some(&wrong_cli)).unwrap_err();
    assert!(err.contains("another launch"), "{err}");
    let wrong_folder = issue_ticket(&conn, session, "claude", "/tmp/ticket-bound").unwrap();
    let err = require_ticket(session, "claude", "/tmp/elsewhere", Some(&wrong_folder)).unwrap_err();
    assert!(err.contains("another launch"), "{err}");
    let good = issue_ticket(&conn, session, "claude", "/tmp/ticket-bound").unwrap();
    assert!(require_ticket(session, "claude", "/tmp/ticket-bound", Some(&good)).is_ok());
    let err = require_ticket(session, "claude", "/tmp/ticket-bound", Some(&good)).unwrap_err();
    assert!(err.contains("already used"), "{err}");
}

#[test]
fn a_banned_cli_gets_no_spawn_ticket_whatever_routed_it() {
    use super::gate::issue_ticket;
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/ban-spawn",
        &json!({ "lockDefault": false, "neverUse": ["Codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let err = issue_ticket(&conn, "app-ban-spawn-1", "codex", "/tmp/ban-spawn").unwrap_err();
    assert!(
        (err).starts_with("Codex is on Never use for "),
        "unexpected refusal"
    );
    assert!(issue_ticket(&conn, "app-ban-spawn-2", "claude", "/tmp/ban-spawn").is_ok());
}

#[test]
fn under_the_lock_a_spawn_needs_the_granted_default_and_nothing_else() {
    use super::gate::{issue_ticket, record_grant, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        0,
    )
    .unwrap();
    let no_grant =
        issue_ticket(&conn, "app-lock-spawn-1", "claude", "/tmp/lock-spawn").unwrap_err();
    assert!(no_grant.contains("has no gate decision"), "{no_grant}");
    record_grant(
        &conn,
        "app-lock-spawn-2",
        &LaunchCheck {
            cli: "claude".into(),
            mono: None,
            project: Some("/tmp/lock-spawn".into()),
            locked_default: Some("claude".into()),
        },
    )
    .unwrap();
    assert!(issue_ticket(&conn, "app-lock-spawn-2", "claude", "/tmp/lock-spawn").is_ok());
    let off_default =
        issue_ticket(&conn, "app-lock-spawn-2", "grok", "/tmp/lock-spawn").unwrap_err();
    assert_eq!(
        off_default,
        "Always use my default is on, and the default is Claude Code, so Grok was not started. Change it in Settings > Crew Defaults."
    );
}

/// WP-141 LOW: a stored policy that doesn't parse is an error. An empty one would drop every Never use.
#[test]
fn a_corrupt_stored_policy_is_an_error_not_an_empty_policy() {
    use super::gate::{check_launch, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/corrupt-policy",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    conn.execute(
        "UPDATE crew_rule_meta SET policy = 'not json' WHERE scope = 'project' AND scope_id = ?1",
        [crate::delivery::settings::key("/tmp/corrupt-policy")],
    )
    .unwrap();
    let refused = check_launch(
        &conn,
        &LaunchCheck {
            cli: "codex".into(),
            mono: None,
            project: Some("/tmp/corrupt-policy".into()),
            locked_default: None,
        },
    )
    .unwrap_err();
    assert!(refused.contains("unreadable"), "{refused}");
    assert!(store::any_lock(&conn).is_err());
}

/// WP-141 HIGH-B: the lock is seen in every saved scope, so a chat's default change is refused when any scope locks.
#[test]
fn any_lock_sees_a_lock_in_any_scope() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    assert!(!store::any_lock(&conn).unwrap());
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/any-lock",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        0,
    )
    .unwrap();
    assert!(store::any_lock(&conn).unwrap());
}

/// Review repro (PR #194 round 5): the spawn gate re-judges the project a launch was gated for. A worker gated into a
/// project whose Never use lists Codex, whose process then starts in its own checkout (a worktree), or in Antigravity's
/// binary folder, or after a restart with no grant, must not get a ticket for Codex. Today the ticket reads the policy
/// of the process's folder only, and a folder that is no project's means the system policy alone.
#[test]
fn review_the_spawn_gate_judges_the_gated_project_not_only_the_process_folder() {
    use super::gate::{issue_ticket, record_grant, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/review-r5-project",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let session = "app-review-r5-worktree-1";
    record_grant(
        &conn,
        session,
        &LaunchCheck {
            cli: "claude".into(),
            mono: None,
            project: Some("/tmp/review-r5-project".into()),
            locked_default: None,
        },
    )
    .unwrap();
    // The same session's process, in its own checkout of that project, asks for a Codex ticket.
    let ticket = issue_ticket(
        &conn,
        session,
        "codex",
        "/tmp/review-r5-worktrees/project-task-1",
    );
    assert!(
        ticket.is_err(),
        "a CLI on the gated project's Never use got a spawn ticket: {ticket:?}"
    );
}

/// WP-141 round 6: every agent CLI start judges Never use for that CLI, whichever path reached the spawn. Each path is
/// the session shape it starts with: Ash's chat, the Lead's chat, a habit run, a fresh-eyes reviewer and an
/// orchestration worker (UUIDs); a worker, a phase worker and an Antigravity child (`app-`, the child with `#n`).
#[test]
fn every_start_path_judges_never_use_at_the_spawn() {
    use super::gate::{judge_spawn, record_grant, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/r6-project",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let granted = LaunchCheck {
        cli: "claude".into(),
        mono: None,
        project: Some("/tmp/r6-project".into()),
        locked_default: None,
    };
    for session in [
        "app-r6-worker-1",
        "app-r6-phase-1-phase-run1",
        "app-r6-antigravity-1",
    ] {
        record_grant(&conn, session, &granted).unwrap();
    }
    use super::gate::judge_start;
    let paths = [
        ("Ash's chat", "3f2a9c1e-ashs-chat", "/tmp/r6-project"),
        ("the Lead's chat", "7d3e5c2a-lead-chat", "/tmp/r6-project"),
        ("a habit run", "9b1f0e4d-habit-run", "/tmp/r6-project"),
        (
            "a fresh-eyes reviewer",
            "c4a8d2f1-fresh-eyes",
            "/tmp/r6-project",
        ),
        (
            "an orchestration worker",
            "e2b7f9a0-orch-worker",
            "/tmp/r6-project",
        ),
        ("a worker", "app-r6-worker-1", "/tmp/r6-project"),
        (
            "a phase worker",
            "app-r6-phase-1-phase-run1",
            "/tmp/r6-project",
        ),
        (
            "an Antigravity child",
            "app-r6-antigravity-1#4",
            "/tmp/r6-antigravity-binary",
        ),
    ];
    for (path, session, folder) in paths {
        let err = judge_spawn(&conn, session, "codex", folder, None).expect_err(path);
        assert!(
            err.starts_with("Codex is on Never use for "),
            "{path}: {err}"
        );
        judge_start(&conn, session, "claude", folder)
            .unwrap_or_else(|err| panic!("{path} was refused a permitted CLI: {err}"));
    }
}

/// WP-141 round 6: the lock is for `app-` sessions. Under it an agent session must be granted its default, and a
/// session with no decision is refused rather than judged by the folder it runs in. A Mono's or Ash's chat (a UUID)
/// is not held to a grant, so it starts; the Never use list still applies to it.
#[test]
fn under_the_lock_an_agent_session_needs_its_grant_and_a_chat_does_not() {
    use super::gate::{judge_start, record_grant, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        0,
    )
    .unwrap();
    judge_start(&conn, "7d3e5c2a-lead-chat", "claude", "/tmp/r6-lock").unwrap();
    let no_grant = judge_start(&conn, "app-r6-lock-1", "claude", "/tmp/r6-lock").unwrap_err();
    assert!(no_grant.contains("has no gate decision"), "{no_grant}");
    record_grant(
        &conn,
        "app-r6-lock-2",
        &LaunchCheck {
            cli: "claude".into(),
            mono: None,
            project: Some("/tmp/r6-lock".into()),
            locked_default: Some("claude".into()),
        },
    )
    .unwrap();
    judge_start(&conn, "app-r6-lock-2", "claude", "/tmp/r6-lock").unwrap();
    let off = judge_start(&conn, "app-r6-lock-2", "grok", "/tmp/r6-lock").unwrap_err();
    assert!(off.contains("the default is Claude Code"), "{off}");
    // The Antigravity child is judged as its session: its `#n` is not a separate decision.
    record_grant(
        &conn,
        "app-r6-lock-3",
        &LaunchCheck {
            cli: "antigravity".into(),
            mono: None,
            project: Some("/tmp/r6-lock".into()),
            locked_default: Some("antigravity".into()),
        },
    )
    .unwrap();
    judge_start(
        &conn,
        "app-r6-lock-3#7",
        "antigravity",
        "/tmp/r6-antigravity-binary",
    )
    .unwrap();
}

/// WP-141 round 6: the policy in force is the most specific one: the grant's project first, then the project that owns
/// the folder, then the system's. A worktree of a project shares its git common directory, so it is that project.
#[test]
fn the_grant_project_beats_the_folder_and_a_worktree_is_its_project() {
    use super::gate::{judge_spawn, record_grant, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/r6-grant-a",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    record_grant(
        &conn,
        "app-r6-grant-1",
        &LaunchCheck {
            cli: "claude".into(),
            mono: None,
            project: Some("/tmp/r6-grant-a".into()),
            locked_default: None,
        },
    )
    .unwrap();
    let err = judge_spawn(&conn, "app-r6-grant-1", "codex", "/tmp/r6-grant-b", None).unwrap_err();
    assert!(
        (err).starts_with("Codex is on Never use for "),
        "unexpected refusal"
    );
    judge_spawn(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        "/tmp/r6-grant-b",
        None,
    )
    .unwrap();

    let root = std::env::temp_dir().join(format!("r6-worktree-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=r6", "-c", "user.email=r6@example.invalid"])
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?} failed");
    };
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r6-wt",
            worktree.to_str().unwrap(),
        ],
    );
    let repo_key = std::fs::canonicalize(&repo)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let worktree_key = std::fs::canonicalize(&worktree)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    store::set_policy(
        &mut conn,
        "project",
        &repo_key,
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let from_worktree = judge_spawn(&conn, "7d3e5c2a-lead-chat", "codex", &worktree_key, None);
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        (from_worktree.unwrap_err()).starts_with("Codex is on Never use for "),
        "unexpected refusal"
    );
}

/// WP-141 round 6: a grant lives in the app database, so a restarted app still judges a resumed worker, or Ash typing
/// into it, against the default it was granted. Reopening the database is the restart.
#[test]
fn a_grant_survives_a_restart_for_a_resumed_worker() {
    use super::gate::{judge_start, record_grant, LaunchCheck};
    let path = std::env::temp_dir().join(format!("r6-grants-{}.sqlite", uuid::Uuid::new_v4()));
    {
        let store = SessionStore::open(path.clone()).unwrap();
        let mut conn = store.lock_conn().unwrap();
        store::set_policy(
            &mut conn,
            "project",
            "/tmp/r6-resume",
            &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
            0,
        )
        .unwrap();
        record_grant(
            &conn,
            "app-r6-resume-1#2",
            &LaunchCheck {
                cli: "claude".into(),
                mono: None,
                project: Some("/tmp/r6-resume".into()),
                locked_default: Some("claude".into()),
            },
        )
        .unwrap();
    }
    let store = SessionStore::open(path.clone()).unwrap();
    let conn = store.lock_conn().unwrap();
    let resumed = judge_start(
        &conn,
        "app-r6-resume-1",
        "claude",
        "/tmp/r6-resumed-elsewhere",
    );
    let off_default = judge_start(
        &conn,
        "app-r6-resume-1",
        "grok",
        "/tmp/r6-resumed-elsewhere",
    );
    let ungranted = judge_start(
        &conn,
        "app-r6-resume-2",
        "claude",
        "/tmp/r6-resumed-elsewhere",
    );
    drop(conn);
    drop(store);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    assert!(resumed.is_ok(), "{resumed:?}");
    assert!(off_default
        .unwrap_err()
        .contains("the default is Claude Code"));
    assert!(ungranted.unwrap_err().contains("has no gate decision"));
}

/// WP-141 round 6 (LOW): a saved policy that does not parse still loads, flagged, so Ash's explicit save replaces it.
/// Before, the load failed, the screen had no revision to save against, and the corrupt policy could not be fixed.
#[test]
fn ashs_explicit_save_replaces_a_corrupt_saved_policy() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/r6-corrupt-save",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    conn.execute(
        "UPDATE crew_rule_meta SET policy = 'not json' WHERE scope = 'project' AND scope_id = ?1",
        [crate::delivery::settings::key("/tmp/r6-corrupt-save")],
    )
    .unwrap();
    let loaded = store::get_rules(&conn, "project", "/tmp/r6-corrupt-save").unwrap();
    assert!(loaded.policy_unreadable);
    let saved = store::set_policy(
        &mut conn,
        "project",
        "/tmp/r6-corrupt-save",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        loaded.revision,
    )
    .unwrap();
    assert!(!saved.policy_unreadable);
    assert_eq!(saved.policy["lockDefault"], json!(true));
    assert!(store::any_lock(&conn).unwrap());
}

/// WP-141 round 6: a Never use refusal names the CLI, the list that holds it, and where to change it. The text is the
/// line the start returns, which the chat shows.
#[test]
fn a_never_use_refusal_names_the_cli_the_list_and_where_to_change_it() {
    use super::gate::{check_launch, judge_start, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/r6-refusal",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let judged = judge_start(&conn, "7d3e5c2a-lead-chat", "codex", "/tmp/r6-refusal").unwrap_err();
    assert!(
        judged.starts_with(&format!(
            "Codex is on Never use for this project ({})",
            crate::delivery::settings::key("/tmp/r6-refusal")
        )),
        "{judged}"
    );
    assert!(
        judged.contains("open Settings > Crew Defaults and edit Never use"),
        "{judged}"
    );
    let checked = check_launch(
        &conn,
        &LaunchCheck {
            cli: "codex".into(),
            mono: None,
            project: Some("/tmp/r6-refusal".into()),
            locked_default: None,
        },
    )
    .unwrap_err();
    assert!(checked.contains("Settings > Crew Defaults"), "{checked}");
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": false, "neverUse": ["grok"], "fallback": [] }),
        0,
    )
    .unwrap();
    let system = judge_start(&conn, "7d3e5c2a-lead-chat", "grok", "/tmp/r6-elsewhere").unwrap_err();
    assert!(
        system.starts_with("Grok is on Never use for everything"),
        "{system}"
    );
}

/// WP-141 round 6: an agent session with no decision under a lock is told to start the worker again, not just refused.
#[test]
fn an_ungranted_worker_under_the_lock_is_told_to_start_again() {
    use super::gate::judge_start;
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        0,
    )
    .unwrap();
    let refused =
        judge_start(&conn, "app-r6-ungranted-1", "claude", "/tmp/r6-ungranted").unwrap_err();
    assert!(refused.contains("has no gate decision"), "{refused}");
    assert!(
        refused.contains("Start the worker again from its chat"),
        "{refused}"
    );
}

/// WP-141 round 6: the OpenCode 2.x bind requires a ticket and consumes it, so a bind without one, or a second bind
/// with the same one, is refused.
#[test]
fn a_v2_session_bind_needs_a_ticket_and_uses_it_once() {
    use super::gate::{bind_v2_session, issue_ticket};
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let session = "app-r6-v2-1";
    let no_ticket = bind_v2_session(&conn, session, "opencode", "/tmp/r6-v2", None).unwrap_err();
    assert!(no_ticket.contains("no crew gate ticket"), "{no_ticket}");
    let ticket = issue_ticket(&conn, session, "opencode", "/tmp/r6-v2").unwrap();
    bind_v2_session(&conn, session, "opencode", "/tmp/r6-v2", Some(&ticket)).unwrap();
    let reused =
        bind_v2_session(&conn, session, "opencode", "/tmp/r6-v2", Some(&ticket)).unwrap_err();
    assert!(reused.contains("already used"), "{reused}");
}

/// WP-141 round 6: grants idle for the window are pruned; a grant whose session was judged recently is kept.
#[test]
fn an_idle_grant_is_pruned_and_a_used_one_is_kept() {
    use super::gate::{judge_start, record_grant, LaunchCheck};
    use super::store::{prune_grants, GRANT_IDLE_MS};
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let grant = |cli: &str| LaunchCheck {
        cli: cli.into(),
        mono: None,
        project: Some("/tmp/r6-prune".into()),
        locked_default: None,
    };
    record_grant(&conn, "app-r6-idle-1", &grant("claude")).unwrap();
    record_grant(&conn, "app-r6-used-1", &grant("claude")).unwrap();
    let long_ago = crate::session_store::now_millis() - GRANT_IDLE_MS - 1_000;
    conn.execute("UPDATE crew_grants SET last_used = ?1", [long_ago])
        .unwrap();
    // A judged start refreshes its grant, so this one survives the prune.
    judge_start(&conn, "app-r6-used-1", "claude", "/tmp/r6-prune").unwrap();
    let pruned = prune_grants(&conn, crate::session_store::now_millis()).unwrap();
    assert_eq!(pruned, 1);
    assert!(store::grant_of(&conn, "app-r6-idle-1").unwrap().is_none());
    assert!(store::grant_of(&conn, "app-r6-used-1").unwrap().is_some());
}

/// Review repro (PR #194 round 6, HIGH-A): a grant never sheds the Never use of the project that owns the folder.
/// `crew_launch_check` records the folder it was handed as the grant's project, unresolved, and `judge_start` then
/// prefers that project over the one owning the spawn folder. A launch gated with a worktree's folder (sessions.start
/// or a phase from a chat sitting in a worktree) or a project's subfolder gets only the system policy, so a CLI on the
/// project's Never use passes the launch gate, gets a ticket and spawns. The same folder with no grant is refused.
#[test]
fn review_r6_a_grant_never_sheds_the_never_use_of_the_project_owning_the_folder() {
    use super::gate::{check_launch, issue_ticket, judge_spawn, record_grant, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    // A project's subfolder (no git needed).
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/review-r6-sub-project",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let sub = "/tmp/review-r6-sub-project/packages/app";
    // Control: judged by the folder alone, the subfolder is the project's, so Codex is refused.
    assert!(judge_spawn(&conn, "5e0c1d2b-ashs-chat", "codex", sub, None).is_err());
    let gated = LaunchCheck {
        cli: "codex".into(),
        mono: None,
        project: Some(sub.into()),
        locked_default: None,
    };
    let launch = check_launch(&conn, &gated);
    let session = "app-review-r6-sub-1";
    let _ = record_grant(&conn, session, &gated);
    let ticket = issue_ticket(&conn, session, "codex", sub);
    let spawn = ticket
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|ticket| judge_spawn(&conn, session, "codex", sub, Some(ticket)));

    // A linked worktree of a project (the realistic shape: a worker's own checkout).
    let root = std::env::temp_dir().join(format!("review-r6-wt-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=r6", "-c", "user.email=r6@example.invalid"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed");
    };
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "review-r6",
            worktree.to_str().unwrap(),
        ],
    );
    let key = |path: &std::path::Path| {
        std::fs::canonicalize(path)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    };
    let (repo_key, worktree_key) = (key(&repo), key(&worktree));
    store::set_policy(
        &mut conn,
        "project",
        &repo_key,
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let control = judge_spawn(&conn, "5e0c1d2b-ashs-chat", "codex", &worktree_key, None);
    let in_worktree = LaunchCheck {
        cli: "codex".into(),
        mono: None,
        project: Some(worktree_key.clone()),
        locked_default: None,
    };
    let wt_launch = check_launch(&conn, &in_worktree);
    let wt_session = "app-review-r6-wt-1";
    let _ = record_grant(&conn, wt_session, &in_worktree);
    let wt_spawn = issue_ticket(&conn, wt_session, "codex", &worktree_key)
        .and_then(|ticket| judge_spawn(&conn, wt_session, "codex", &worktree_key, Some(&ticket)));
    let _ = std::fs::remove_dir_all(&root);

    assert!(
        control.is_err(),
        "control: the worktree with no grant is its project's"
    );
    let passed: Vec<&str> = [
        ("subfolder launch gate", launch.is_ok()),
        ("subfolder spawn", spawn.is_ok()),
        ("worktree launch gate", wt_launch.is_ok()),
        ("worktree spawn", wt_spawn.is_ok()),
    ]
    .into_iter()
    .filter_map(|(what, ok)| ok.then_some(what))
    .collect();
    assert!(
        passed.is_empty(),
        "Codex is on the project's Never use, yet these passed: {passed:?}"
    );
}

/// WP-141 round 7 (CI, Windows): a project is saved and read under one key on every OS, however its folder is spelled.
#[test]
fn a_project_is_saved_and_read_under_one_key_on_every_os() {
    assert_eq!(
        crate::delivery::settings::key("/tmp/r7-one-key/"),
        crate::delivery::settings::key("/tmp/r7-one-key")
    );
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/r7-one-key/",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let loaded = store::get_rules(&conn, "project", "/tmp/r7-one-key").unwrap();
    assert!(loaded.policy_own);
    assert_eq!(loaded.policy["neverUse"], json!(["codex"]));
}

/// WP-141 round 7 (LOW): a lock refusal names Settings > Crew Defaults, so the person knows where the lock is changed.
#[test]
fn a_lock_refusal_names_where_to_change_it() {
    use super::gate::{judge_start, record_grant, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        0,
    )
    .unwrap();
    record_grant(
        &conn,
        "app-r7-lock-name-1",
        &LaunchCheck {
            cli: "claude".into(),
            mono: None,
            project: None,
            locked_default: Some("claude".into()),
        },
    )
    .unwrap();
    let refused =
        judge_start(&conn, "app-r7-lock-name-1", "grok", "/tmp/r7-lock-name").unwrap_err();
    assert!(refused.contains("the default is Claude Code"), "{refused}");
    assert!(
        refused.contains("Change it in Settings > Crew Defaults"),
        "{refused}"
    );
}

/// Review repro (PR #194 round 7, HIGH-C): a project inside another project's repository keeps its own Never use.
/// `project_owning` returns the FIRST project whose git common directory the folder shares, before it looks at which
/// project the folder actually sits in. With a hub project at a repository's root and another at a package inside it
/// (one repo, two projects), a launch or spawn in the package's own folder is judged by the root project alone, and
/// `record_grant` stores the root as the grant's project, so the package's Never use never applies. In round 6 the
/// launch gate still read the package's own saved policy.
#[test]
fn review_r7_a_nested_project_in_the_same_repository_keeps_its_never_use() {
    use super::gate::{check_launch, issue_ticket, judge_spawn, record_grant, LaunchCheck};
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let root = std::env::temp_dir().join(format!("review-r7-nested-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let package = repo.join("packages").join("app");
    std::fs::create_dir_all(&package).unwrap();
    let out = std::process::Command::new("git")
        .current_dir(&repo)
        .args(["init", "-q"])
        .output()
        .unwrap();
    assert!(out.status.success(), "git init failed");
    let key = |path: &std::path::Path| {
        std::fs::canonicalize(path)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    };
    let (repo_key, package_key) = (key(&repo), key(&package));
    // The repository's root project has a saved policy of its own (nothing banned) ...
    store::set_policy(
        &mut conn,
        "project",
        &repo_key,
        &json!({ "lockDefault": false, "neverUse": [], "fallback": ["claude"] }),
        0,
    )
    .unwrap();
    // ... and the package, a hub project of its own, bans Codex.
    store::set_policy(
        &mut conn,
        "project",
        &package_key,
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let owner = store::projects_owning(&conn, &package_key);
    let chat = judge_spawn(&conn, "5e0c1d2b-ashs-chat", "codex", &package_key, None);
    let gated = LaunchCheck {
        cli: "codex".into(),
        mono: None,
        project: Some(package_key.clone()),
        locked_default: None,
    };
    let launch = check_launch(&conn, &gated);
    let session = "app-review-r7-nested-1";
    let _ = record_grant(&conn, session, &gated);
    let spawn = issue_ticket(&conn, session, "codex", &package_key)
        .and_then(|ticket| judge_spawn(&conn, session, "codex", &package_key, Some(&ticket)));
    let _ = std::fs::remove_dir_all(&root);

    let passed: Vec<&str> = [
        ("a chat's spawn in the package", chat.is_ok()),
        ("the launch gate for the package", launch.is_ok()),
        ("a granted worker's spawn in the package", spawn.is_ok()),
    ]
    .into_iter()
    .filter_map(|(what, ok)| ok.then_some(what))
    .collect();
    assert!(
        passed.is_empty(),
        "Codex is on the package project's Never use, yet these passed: {passed:?} (owner read as {owner:?})"
    );
}

/// WP-141 round 8 (MED-A): a project whose git cannot be read fails the judgment only when it could own the folder. A
/// broken project elsewhere refuses no unrelated folder. (A `.git` file with garbage in it, so the test runs as root too.)
#[test]
fn a_broken_project_elsewhere_does_not_refuse_an_unrelated_folder() {
    use super::gate::judge_start;
    let root = std::env::temp_dir().join(format!("r8-broken-{}", uuid::Uuid::new_v4()));
    let broken = root.join("broken");
    let plain = root.join("plain");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::write(broken.join(".git"), "garbage\n").unwrap();
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        broken.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let judged = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        plain.to_str().unwrap(),
    );
    let _ = std::fs::remove_dir_all(&root);
    judged.expect("an unrelated folder is not refused by another project's broken git");
}

/// WP-141 round 8 (LOW): the spawn check judges the crew folder and the folder the process runs in. A clean crew folder
/// does not clear a banned process folder.
#[test]
fn a_banned_process_folder_is_refused_even_when_the_crew_folder_is_clean() {
    use super::gate::judge_spawn_in;
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        "/tmp/r8-banned",
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let err = judge_spawn_in(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        "/tmp/r8-crew-clean",
        "/tmp/r8-banned/package",
        None,
    )
    .unwrap_err();
    assert!(
        err.starts_with("Codex is on Never use for this project"),
        "{err}"
    );
}

/// WP-141 round 9 (HIGH, Windows): the same folder spelled another way (forward slashes, a lower-case drive, or a path
/// through a symlink such as /var on macOS) is one folder, so its worktree still gets the project's Never use.
#[test]
fn a_worktree_spelled_another_way_still_gets_its_projects_never_use() {
    use super::gate::judge_start;
    let root = std::env::temp_dir().join(format!("r9-spelling-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=r9", "-c", "user.email=r9@example.invalid"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed");
    };
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r9-wt",
            worktree.to_str().unwrap(),
        ],
    );
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        repo.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let spelled = spelled_differently(&worktree);
    let judged = judge_start(&conn, "7d3e5c2a-lead-chat", "codex", &spelled);
    let _ = std::fs::remove_dir_all(&root);
    let err = judged.expect_err("the worktree is its project, however it is spelled");
    assert!(
        err.starts_with("Codex is on Never use for this project"),
        "{err}"
    );
}

/// The folder spelled the other way round: forward slashes and a lower-case drive on Windows, the path as given
/// elsewhere (on macOS that is the /var form of /private/var).
fn spelled_differently(path: &std::path::Path) -> String {
    if cfg!(windows) {
        let text = path.to_string_lossy().replace('\\', "/");
        let mut chars = text.chars();
        match chars.next() {
            Some(drive) if chars.next() == Some(':') => {
                format!("{}{}", drive.to_ascii_lowercase(), &text[1..])
            }
            _ => text,
        }
    } else {
        path.to_string_lossy().into_owned()
    }
}

/// WP-141 round 9: the path text rules, the mapping inside a checkout, and the fail-closed case, checked on every OS.
#[test]
fn path_keys_and_the_checkout_mapping_follow_one_form() {
    use super::store::{owns_within_checkout, path_key_of_text};
    assert_eq!(path_key_of_text(r"\\?\C:\Repo\Wt\"), "c:/repo/wt");
    assert_eq!(
        path_key_of_text("C:/REPO/wt"),
        path_key_of_text(r"c:\repo\wt")
    );
    assert_eq!(
        path_key_of_text(r"\\?\UNC\server\share\x"),
        "//server/share/x"
    );
    assert_eq!(
        owns_within_checkout(
            "c:/repo/wt/packages/app",
            "c:/repo/wt",
            "c:/repo/packages/app",
            "c:/repo"
        ),
        Ok(true)
    );
    assert_eq!(
        owns_within_checkout(
            "c:/repo/wt/other",
            "c:/repo/wt",
            "c:/repo/packages/app",
            "c:/repo"
        ),
        Ok(false)
    );
    // A folder outside its own checkout cannot be placed: that refuses, it is never read as no owner.
    assert!(owns_within_checkout("/x/y", "/repo/wt", "/repo/packages/app", "/repo").is_err());
}

/// WP-141 round 9: the checkout cache is bounded, and the oldest entry goes first.
#[test]
fn the_checkout_cache_drops_its_oldest_entry_past_the_bound() {
    use super::store::bounded_put;
    let mut entries: Vec<(std::path::PathBuf, u32)> = Vec::new();
    for index in 0..600u32 {
        bounded_put(
            &mut entries,
            std::path::PathBuf::from(format!("/folder/{index}")),
            index,
            512,
        );
    }
    assert_eq!(entries.len(), 512);
    assert_eq!(entries.first().map(|(_, value)| *value), Some(88));
    assert_eq!(entries.last().map(|(_, value)| *value), Some(599));
}

/// WP-141 round 9 (MED-A): a project whose `.git` cannot be read, and that shares no checkout with the folder, refuses
/// nothing. Garbage in its `.git` is unreadable from the files, so it is never a candidate and git is not run for it.
#[test]
fn a_project_with_dubious_git_elsewhere_does_not_refuse_an_unrelated_start() {
    use super::gate::judge_start;
    let root = std::env::temp_dir().join(format!("r9-dubious-{}", uuid::Uuid::new_v4()));
    let elsewhere = root.join("elsewhere");
    let plain = root.join("plain");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::write(elsewhere.join(".git"), "garbage\n").unwrap();
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        elsewhere.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let judged = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        plain.to_str().unwrap(),
    );
    let _ = std::fs::remove_dir_all(&root);
    judged.expect("an unrelated start is not refused by another project's git");
}

/// WP-141 round 9 (MED-A): a candidate whose checkout git cannot read refuses the judgment. Both folders are real
/// checkouts of one repository (a worktree and its main checkout); the repository's config is then broken.
#[test]
fn a_candidate_whose_checkout_git_cannot_read_refuses_the_judgment() {
    use super::gate::judge_start;
    let root = std::env::temp_dir().join(format!("r9-broken-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=r9", "-c", "user.email=r9@example.invalid"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed");
    };
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r9-broken-wt",
            worktree.to_str().unwrap(),
        ],
    );
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        repo.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    std::fs::write(repo.join(".git").join("config"), "[core\n garbage = = \n").unwrap();
    let judged = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "claude",
        worktree.to_str().unwrap(),
    );
    let _ = std::fs::remove_dir_all(&root);
    let err = judged.expect_err("a candidate git cannot read refuses the judgment");
    assert!(err.contains("could not be read"), "{err}");
}

/// WP-141 round 9 (LOW-1): a project saved before its folder existed still owns that folder once it exists.
#[test]
fn a_project_saved_before_its_folder_existed_still_owns_it() {
    use super::gate::judge_start;
    let root = std::env::temp_dir().join(format!("r9-late-{}", uuid::Uuid::new_v4()));
    let project = root.join("project");
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        project.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    std::fs::create_dir_all(project.join("sub")).unwrap();
    let judged = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        project.join("sub").to_str().unwrap(),
    );
    let _ = std::fs::remove_dir_all(&root);
    let err = judged.expect_err("the project owns its folder once the folder exists");
    assert!(
        err.starts_with("Codex is on Never use for this project"),
        "{err}"
    );
}

/// WP-141 round 10: a linked worktree whose own `.git` file is garbage must not lose its project's Never use.
/// The files cannot name a common directory, so the judgment asks git and refuses when that read fails too.
/// An unrelated project's unreadable entry still refuses nothing (the round 9 MED-A tests).
#[test]
fn a_worktree_with_a_garbage_git_file_refuses_a_banned_cli() {
    use super::gate::judge_spawn;
    let root = std::env::temp_dir().join(format!("r10-garbage-wt-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args([
                "-c",
                "user.name=r10",
                "-c",
                "user.email=r10@example.invalid",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed");
    };
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r10-wt",
            worktree.to_str().unwrap(),
        ],
    );
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        repo.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    std::fs::write(worktree.join(".git"), "garbage\n").unwrap();
    let judged = judge_spawn(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        worktree.to_str().unwrap(),
        None,
    );
    let _ = std::fs::remove_dir_all(&root);
    let err = judged.expect_err(
        "a worktree whose own git file cannot be read must not drop its project's Never use",
    );
    assert!(err.contains("could not be read"), "{err}");
}
