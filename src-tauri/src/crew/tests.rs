//! WP-13: precedence, the signed-in default, which failures move, the retry budget, and a usage limit that waits.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::budget::{budget_or_default, normalize_failure_policy};
use super::failure::{self, Kind};
use super::reroute::{decide, Attempt, FailureInput};
use super::resolve::{role_model, Pick, Presence};
use super::rules::{self, Rule};
use super::store::{self, FailureQuery, RouteQuery, RuleDraft};
use crate::delegations::{self, RecordInput, SettleInput};
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
        &[plugin],
    )
    .unwrap();
    assert_eq!(only_plugin.cli.as_deref(), Some("claude"));
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
fn a_usage_limit_pauses_then_the_watcher_resumes_the_same_row() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let row = fail_row(&mut conn, "worker-pause", Some("usage_limit"), Some(5_000));
    let who = [("claude", true, true)];
    let paused = store::on_failure(
        &mut conn,
        &failure(&row.id, Some("quota"), None, "claude", &who, None, None),
        1_200,
    )
    .unwrap();
    assert_eq!(paused.action, "pause");
    assert_eq!(paused.until, Some(5_000));
    assert!(paused.applied);
    assert_eq!(hold_count(&conn, &row.id), 1);
    crate::watcher::tick(&mut conn, 4_000).unwrap();
    let waiting = delegations::get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(waiting.state, "failed");
    assert_eq!(waiting.generation, 1);
    crate::watcher::tick(&mut conn, 5_000).unwrap();
    let resumed = delegations::get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(resumed.state, "running");
    assert_eq!(resumed.generation, 2);
    assert_eq!(resumed.error_class, None);
    assert_eq!(hold_count(&conn, &row.id), 0);
    assert_eq!(
        outcomes(&conn, &row.id),
        vec!["paused".to_string(), "resumed".to_string()]
    );
    crate::watcher::tick(&mut conn, 9_000).unwrap();
    assert_eq!(
        delegations::get(&conn, &row.id)
            .unwrap()
            .unwrap()
            .generation,
        2
    );
    conn.execute(
        "INSERT INTO crew_holds (delegation_id, hold, resume_at, child_session, cli, model, effort, claim) VALUES (?1, 'paused', 1, 'worker-pause', 'claude', NULL, NULL, 0)",
        [&row.id],
    )
    .unwrap();
    crate::watcher::tick(&mut conn, 9_000).unwrap();
    assert_eq!(
        delegations::get(&conn, &row.id)
            .unwrap()
            .unwrap()
            .generation,
        2
    );
    assert_eq!(hold_count(&conn, &row.id), 0);
}

#[test]
fn a_cancelled_or_disposed_row_is_not_reopened() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let running = delegations::record(
        &mut conn,
        RecordInput {
            owner_session: "lead".into(),
            request_id: "req-stop".into(),
            child_session: "worker-stop".into(),
            ..RecordInput::default()
        },
        1_000,
    )
    .unwrap();
    delegations::settle(
        &mut conn,
        SettleInput {
            id: running.id.clone(),
            generation: 1,
            state: "cancelled".into(),
            ..SettleInput::default()
        },
        1_100,
    )
    .unwrap();
    conn.execute(
        "INSERT INTO crew_holds (delegation_id, hold, resume_at, child_session, cli, model, effort, claim) VALUES (?1, 'paused', 1, 'worker-stop', 'claude', NULL, NULL, 0)",
        [&running.id],
    )
    .unwrap();
    store::resume_due(&mut conn, 2_000).unwrap();
    let stayed = delegations::get(&conn, &running.id).unwrap().unwrap();
    assert_eq!(stayed.state, "cancelled");
    assert_eq!(stayed.generation, 1);
    assert_eq!(hold_count(&conn, &running.id), 0);

    let failed = fail_row(
        &mut conn,
        "worker-dispose",
        Some("usage_limit"),
        Some(9_000),
    );
    let paused = store::on_failure(
        &mut conn,
        &failure(
            &failed.id,
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
    assert_eq!(paused.action, "pause");
    delegations::cancel(
        &mut conn,
        std::slice::from_ref(&failed.id),
        Some("Stopped.".into()),
        None,
        1_300,
    )
    .unwrap();
    store::resume_due(&mut conn, 9_000).unwrap();
    let disposed = delegations::get(&conn, &failed.id).unwrap().unwrap();
    assert_eq!(disposed.state, "failed");
    assert_ne!(disposed.state, "running");
    assert_eq!(disposed.generation, 1);
    assert_eq!(hold_count(&conn, &failed.id), 0);
}

/// The hold names one delegation. A later task on the same child session is another row, and the timer must not touch it.
#[test]
fn a_due_hold_resumes_the_delegation_it_was_recorded_for() {
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
    let running = delegations::record(
        &mut conn,
        RecordInput {
            owner_session: "lead".into(),
            request_id: "req-later-running".into(),
            child_session: "shared-running".into(),
            ..RecordInput::default()
        },
        2_000,
    )
    .unwrap();
    store::resume_due(&mut conn, 5_000).unwrap();
    let later = delegations::get(&conn, &running.id).unwrap().unwrap();
    assert_eq!(later.state, "running");
    assert_eq!(later.generation, running.generation);
    let resumed = delegations::get(&conn, &paused.id).unwrap().unwrap();
    assert_eq!(resumed.state, "running");
    assert_eq!(resumed.generation, paused.generation + 1);
    assert_eq!(hold_count(&conn, &paused.id), 0);
    assert_eq!(
        outcomes(&conn, &paused.id),
        vec!["paused".to_string(), "resumed".to_string()]
    );

    let task = fail_row(&mut conn, "shared-task", Some("usage_limit"), Some(8_000));
    store::on_failure(
        &mut conn,
        &failure(
            &task.id,
            None,
            None,
            "claude",
            &[("claude", true, true)],
            None,
            None,
        ),
        2_100,
    )
    .unwrap();
    let denied = delegations::record(
        &mut conn,
        RecordInput {
            owner_session: "lead".into(),
            request_id: "req-later-denied".into(),
            child_session: "shared-task".into(),
            ..RecordInput::default()
        },
        3_000,
    )
    .unwrap();
    delegations::settle(
        &mut conn,
        SettleInput {
            id: denied.id.clone(),
            generation: denied.generation,
            state: "failed".into(),
            error_class: Some("approval_denied".into()),
            ..SettleInput::default()
        },
        3_100,
    )
    .unwrap();
    store::resume_due(&mut conn, 8_000).unwrap();
    let stayed = delegations::get(&conn, &denied.id).unwrap().unwrap();
    assert_eq!(stayed.state, "failed");
    assert_eq!(stayed.error_class.as_deref(), Some("approval_denied"));
    assert_eq!(stayed.generation, denied.generation);
    let own = delegations::get(&conn, &task.id).unwrap().unwrap();
    assert_eq!(own.state, "running");
    assert_eq!(own.generation, task.generation + 1);
    assert_eq!(hold_count(&conn, &task.id), 0);
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
    assert!(resumed.applied);
    assert_eq!(
        delegations::get(&conn, &past.id).unwrap().unwrap().state,
        "running"
    );
    assert_eq!(hold_count(&conn, &past.id), 0);
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
