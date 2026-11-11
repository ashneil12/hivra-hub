//! WP-92: the one sentence, as tests. A value exists in the person's keychain and in the one place they approved, and
//! in no transcript, log line, error message, tool result, database row or export. These tests are deliberately blunt:
//! they plant a value and then search every place the app could have kept it.

use super::store::{Memory, Vault};
use super::*;
use crate::session_store::SessionStore;
use std::process::Command;

const VALUE: &str = "sk_live_51NxAbCdEfGhIjKlMnOp";
const NAME: &str = "stripe-api-key";

struct Bench {
    store: SessionStore,
    vault: Memory,
    now: i64,
}

impl Bench {
    fn new() -> Self {
        Self {
            store: SessionStore::open_in_memory().unwrap(),
            vault: Memory::new(),
            now: 1_700_000_000_000,
        }
    }
}

/// Every text a table holds, one string per row, with SQLite's own quoting so a value cannot hide behind an escaping.
fn every_table_text(conn: &rusqlite::Connection) -> String {
    let mut tables = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap();
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
        for table in rows {
            tables.push(table.unwrap());
        }
    }
    let mut all = String::new();
    for table in tables {
        let Ok(mut stmt) = conn.prepare(&format!("SELECT * FROM \"{table}\"")) else {
            continue;
        };
        let columns = stmt.column_count();
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for index in 0..columns {
                all.push_str(&format!("{:?} ", row.get_ref(index).unwrap()));
            }
            all.push('\n');
        }
    }
    all
}

fn run_request(mono: &str) -> RunRequest {
    RunRequest {
        chat: "chat-1".into(),
        mono: Some(mono.into()),
        project: None,
        name: NAME.into(),
        env: "STRIPE_API_KEY".into(),
        command: vec!["/usr/bin/true".into(), "customers".into(), "list".into()],
        cwd: None,
        timeout_seconds: None,
    }
}

fn worker_request() -> worker::WorkerRequest {
    worker::WorkerRequest {
        chat: "chat-1".into(),
        mono: "Tally".into(),
        project: None,
        executable: "claude".into(),
        secrets: vec![worker::WorkerSecret {
            name: NAME.into(),
            env: "STRIPE_API_KEY".into(),
        }],
    }
}

#[test]
fn a_saved_value_is_in_no_database_row_whatever_window_wrote_it() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    let saved = save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        Some("Stripe"),
        VALUE,
        bench.now,
    )
    .unwrap();
    // The one deliberate excerpt: the last four characters, which the page shows.
    assert_eq!(saved.last4.as_deref(), Some("MnOp"));
    // A request, a grant and a `.env` record too, so no table is left out of the search.
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        NAME,
        "mono",
        "Tally",
        "/usr/bin/true",
        "",
        "",
        "always",
        bench.now,
    )
    .unwrap();
    open_request(
        &bench.vault,
        &conn,
        RequestInput {
            chat: "chat-1".into(),
            mono: Some("Tally".into()),
            project: None,
            scope: Some(SCOPE_GLOBAL.into()),
            name: "another-key".into(),
            why: "to list customers".into(),
        },
        bench.now,
    )
    .unwrap();
    record_env_write(&conn, SCOPE_GLOBAL, NAME, "/p", "STRIPE_API_KEY", bench.now).unwrap();
    let commit = conn.transaction().unwrap();
    commit.commit().unwrap();
    let dump = every_table_text(&conn);
    for form in scrub::needles(VALUE) {
        assert!(!dump.contains(&form), "the database holds {form}: {dump}");
    }
    let _ = &mut conn;
}

#[test]
fn no_handle_or_error_sentence_carries_the_value() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    let saved = save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    let json = serde_json::to_string(&handles(&conn).unwrap()).unwrap();
    assert!(!json.contains(VALUE), "{json}");
    assert!(!format!("{saved:?}").contains(VALUE));
    // The refusal for a wrong name says the name, never a neighbouring value.
    let refused = reveal(&bench.vault, SCOPE_GLOBAL, "missing-key").unwrap_err();
    assert!(!refused.contains(VALUE), "{refused}");
    // A damaged grant never echoes its bytes.
    let dir = std::env::temp_dir().join(format!("wp92-grant-{}", uuid::Uuid::new_v4()));
    let damaged = grant::check(&bench.vault, "not-base64!", &dir, bench.now).unwrap_err();
    assert!(!damaged.contains(VALUE), "{damaged}");
    // A command run's error paths are plain sentences.
    let request = RunRequest {
        chat: "chat-1".into(),
        mono: Some("Tally".into()),
        project: None,
        name: NAME.into(),
        env: "PATH".into(),
        command: vec!["/usr/bin/true".into()],
        cwd: None,
        timeout_seconds: None,
    };
    let refused = prepare_run(&bench.vault, &mut conn, request, bench.now).unwrap_err();
    assert!(!refused.contains(VALUE), "{refused}");
}

#[test]
fn dev_and_daily_names_never_cross_and_a_daily_grant_does_not_verify_in_a_dev_copy() {
    use crate::hub_keychain::{scoped_service, DEV_PREFIX};
    use crate::instance::Kind;
    let daily = service(SCOPE_GLOBAL, NAME).unwrap();
    assert_eq!(daily, "monocode-hub:secret:global:stripe-api-key");
    assert_eq!(
        scoped_service(Kind::Dev, &daily),
        "monocode-hub-dev:secret:global:stripe-api-key"
    );
    assert!(!scoped_service(Kind::Dev, &daily).starts_with("monocode-hub:secret:"));

    // Two copies have two different signing keys, so a grant made by the daily app is refused in a dev copy.
    let daily_vault = Memory::new();
    let dev_vault = Memory::new();
    dev_vault
        .write(grant::KEY_SERVICE, grant::KEY_ACCOUNT, &"ab".repeat(32))
        .unwrap();
    let payload = grant::Payload {
        program_identity: String::new(),
        scope: SCOPE_GLOBAL.into(),
        name: NAME.into(),
        version: 1,
        subject: "Tally".into(),
        env: "STRIPE_API_KEY".into(),
        command: vec!["/usr/bin/true".into()],
        cwd: None,
        nonce: "0123456789abcdef".into(),
        expires_at: 9_999_999_999_999,
        timeout_seconds: 120,
    };
    let signed = grant::sign_payload(&daily_vault, &payload).unwrap();
    let dir = std::env::temp_dir().join(format!("wp92-grant-{}", uuid::Uuid::new_v4()));
    let refused = grant::check(&dev_vault, &signed, &dir, 1_700_000_000_000).unwrap_err();
    assert!(refused.contains("didn't sign"), "{refused}");
    assert!(grant::check(&daily_vault, &signed, &dir, 1_700_000_000_000).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
    assert!(DEV_PREFIX.starts_with("monocode-hub-dev"));
}

#[test]
fn a_dev_copy_maps_every_secret_service_it_can_form_under_the_dev_prefix() {
    use crate::hub_keychain::{scoped_service, DEV_PREFIX};
    use crate::instance::Kind;
    let long_project = format!("/p/{}", "x".repeat(300));
    let scopes = [
        SCOPE_GLOBAL.to_string(),
        scope_for(Some("/p/hivra")),
        scope_for(Some(&long_project)),
    ];
    for scope in &scopes {
        for name in [NAME, "a", "stripe-api-key-2"] {
            let daily = service(scope, name).unwrap();
            assert!(daily.starts_with("monocode-hub:secret:"), "{daily}");
            let dev = scoped_service(Kind::Dev, &daily);
            assert!(dev.starts_with(DEV_PREFIX), "{dev}");
            assert!(!dev.starts_with("monocode-hub:"), "{dev}");
        }
    }
}

#[test]
fn the_export_index_holds_the_metadata_and_no_value() {
    let bench = Bench::new();
    let conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        Some("Stripe"),
        VALUE,
        bench.now,
    )
    .unwrap();
    let index = serde_json::to_string(&index_json(&conn).unwrap()).unwrap();
    for form in scrub::needles(VALUE) {
        assert!(!index.contains(&form), "the index holds {form}");
    }
    assert!(index.contains(NAME));
    assert!(index.contains("Stripe"));
    assert!(index.contains("MnOp"));
    // Import lands as metadata with no value: it is listed, and has to be filled in before use.
    let other = Bench::new();
    let conn = other.store.lock_conn().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&index).unwrap();
    assert_eq!(import_index(&conn, &parsed, other.now).unwrap(), 1);
    let rows = handles(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].needs_value);
    assert!(!has_value(&other.vault, SCOPE_GLOBAL, NAME).unwrap());
    assert!(grants_for(&conn, SCOPE_GLOBAL, NAME).unwrap().is_empty());
    assert!(env_writes_for(&conn, SCOPE_GLOBAL, NAME)
        .unwrap()
        .is_empty());
}

#[test]
fn holds_known_value_catches_the_value_in_any_shape() {
    let bench = Bench::new();
    let conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    for form in scrub::needles(VALUE) {
        let note = format!("a memory note that mentions {form} in passing");
        assert!(
            holds_known_value(&bench.vault, &conn, Some(SCOPE_GLOBAL), &note),
            "missed {form}"
        );
    }
    assert!(!holds_known_value(
        &bench.vault,
        &conn,
        Some(SCOPE_GLOBAL),
        "a note about something else"
    ));
}

#[test]
fn a_worker_gets_the_one_variable_and_its_output_is_scrubbed() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        NAME,
        "mono",
        "Tally",
        "worker:claude",
        "",
        "worker:claude",
        "always",
        bench.now,
    )
    .unwrap();
    let outcome = worker::prepare(&bench.vault, &mut conn, worker_request(), bench.now).unwrap();
    let worker::WorkerOutcome::Ready { secrets } = outcome else {
        panic!("expected ready, got {outcome:?}");
    };
    worker::clear_for_tests();
    worker::arm("worker-1", secrets);
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    // The spawn takes the store's lock itself, so this test lets go of its own first.
    drop(conn);
    worker::apply_to_child("worker-1", &bench.vault, &mut cmd, &bench.store, bench.now).unwrap();
    let envs: Vec<(String, String)> = cmd
        .get_envs()
        .filter_map(|(key, value)| {
            Some((
                key.to_string_lossy().into_owned(),
                value?.to_string_lossy().into_owned(),
            ))
        })
        .collect();
    assert_eq!(
        envs,
        vec![("STRIPE_API_KEY".to_string(), VALUE.to_string())]
    );
    assert!(!envs.iter().any(|(key, _)| key.starts_with("MONOCODE_")));
    // The worker printing the value reaches the app as the marker, not the bytes.
    let line = format!("{{\"text\":\"the key is {VALUE}\"}}");
    let scrubbed = worker::scrub_line("worker-1", line);
    assert!(!scrubbed.contains(VALUE), "{scrubbed}");
    assert!(scrubbed.contains(scrub::MARKER));
    // A session with no secrets is unchanged.
    assert_eq!(worker::scrub_line("other", "plain".into()), "plain");
    worker::forget("worker-1");
    assert_eq!(worker::scrub_line("worker-1", VALUE.into()), VALUE);
}

/// WP-92 step 6: a worker that holds a key never inherits the app's own `MONOCODE_*` variables. `cmd.get_envs()` shows
/// only what was set, so this asserts the removal itself: the parent's probe variable must come back as a removal.
#[test]
fn the_worker_environment_holds_no_inherited_monocode_value() {
    const PROBE: &str = "MONOCODE_WP92_INHERIT_PROBE";
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        NAME,
        "mono",
        "Tally",
        "worker:claude",
        "",
        "worker:claude",
        "always",
        bench.now,
    )
    .unwrap();
    let outcome = worker::prepare(&bench.vault, &mut conn, worker_request(), bench.now).unwrap();
    let worker::WorkerOutcome::Ready { secrets } = outcome else {
        panic!("expected ready, got {outcome:?}");
    };
    worker::clear_for_tests();
    worker::arm("worker-inherit", secrets);
    drop(conn);
    // The app's process carries a MONOCODE_* variable; the worker must not inherit it.
    std::env::set_var(PROBE, "parent-only");
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    let applied = worker::apply_to_child(
        "worker-inherit",
        &bench.vault,
        &mut cmd,
        &bench.store,
        bench.now,
    );
    std::env::remove_var(PROBE);
    applied.unwrap();
    let removed: Vec<String> = cmd
        .get_envs()
        .filter(|(_, value)| value.is_none())
        .map(|(key, _)| key.to_string_lossy().into_owned())
        .collect();
    assert!(
        removed.iter().any(|key| key == PROBE),
        "the worker still inherits {PROBE}: removed = {removed:?}"
    );
    worker::forget("worker-inherit");
}

#[test]
fn a_worker_whose_output_cannot_be_scrubbed_is_refused_the_value() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        NAME,
        "mono",
        "Tally",
        "worker:opencode",
        "",
        "worker:opencode",
        "always",
        bench.now,
    )
    .unwrap();
    // Even with the grant in hand and the person not asked, the tool is refused before anything is armed: the value
    // must not go into a child whose output the app never reads line by line.
    let mut request = worker_request();
    request.executable = "opencode".into();
    assert_eq!(
        worker::prepare(&bench.vault, &mut conn, request, bench.now).unwrap_err(),
        "this tool can't keep a key out of its own output, so it was not given the key"
    );
    // A handle armed by an older build is refused at the spawn too.
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        NAME,
        "mono",
        "Tally",
        "worker:claude",
        "",
        "worker:claude",
        "always",
        bench.now,
    )
    .unwrap();
    let mut claude = worker_request();
    claude.executable = "claude".into();
    let worker::WorkerOutcome::Ready { mut secrets } =
        worker::prepare(&bench.vault, &mut conn, claude, bench.now).unwrap()
    else {
        panic!("the grant is there");
    };
    for secret in &mut secrets {
        secret.executable = "opencode".into();
    }
    worker::clear_for_tests();
    worker::arm("worker-open", secrets);
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    drop(conn);
    let refused = worker::apply_to_child(
        "worker-open",
        &bench.vault,
        &mut cmd,
        &bench.store,
        bench.now,
    )
    .unwrap_err();
    assert_eq!(
        refused,
        "this tool can't keep a key out of its own output, so it was not given the key"
    );
    assert_eq!(cmd.get_envs().count(), 0);
    // Every other worker program the app runs delivers line stdout, so only OpenCode is refused.
    for line_stdout in [
        "claude",
        "codex",
        "cursor",
        "grok",
        "pi",
        "omp",
        "fx",
        "hermes",
        "antigravity",
        "devin",
        "/usr/local/bin/Claude",
    ] {
        assert!(worker::delivers_line_stdout(line_stdout), "{line_stdout}");
    }
    for sse in ["opencode", "OpenCode", "/usr/local/bin/opencode", "sh", ""] {
        assert!(!worker::delivers_line_stdout(sse), "{sse}");
    }
}

#[test]
fn a_worker_without_an_approval_is_asked_first_and_gets_nothing() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    let first = worker::prepare(&bench.vault, &mut conn, worker_request(), bench.now).unwrap();
    assert!(matches!(first, worker::WorkerOutcome::Waiting { .. }));
    let key = match first {
        worker::WorkerOutcome::Waiting { decision_key, .. } => decision_key,
        _ => unreachable!(),
    };
    // The question names the Mono and says the whole session will hold it.
    let decision = crate::decisions::get(&conn, "", &key).unwrap().unwrap();
    assert!(decision.question.contains("Tally"));
    assert!(decision.question.contains("whole worker session"));
    assert!(decision.question.contains("narrower"));
    // Nothing was armed: a spawn now would carry no value.
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    worker::apply_to_child(
        "never-armed",
        &bench.vault,
        &mut cmd,
        &bench.store,
        bench.now,
    )
    .unwrap();
    assert_eq!(cmd.get_envs().count(), 0);
    // "Once" is a grant for exactly one worker.
    crate::decisions::answer(&mut conn, "", &key, "Once", None, bench.now + 1).unwrap();
    let second = worker::prepare(&bench.vault, &mut conn, worker_request(), bench.now + 2).unwrap();
    assert!(matches!(second, worker::WorkerOutcome::Ready { .. }));
    let third = worker::prepare(&bench.vault, &mut conn, worker_request(), bench.now + 3).unwrap();
    assert!(matches!(third, worker::WorkerOutcome::Waiting { .. }));
}

// ---- only the person approves ---------------------------------------------------------------------------------------

#[test]
fn a_chat_forwarding_an_answer_on_a_secret_key_leaves_it_open_and_waiting() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    // The first run asks the person. This is the card the ask_person tool's `answer` argument would try to settle.
    let RunOutcome::Waiting { decision_key, .. } =
        prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now).unwrap()
    else {
        panic!("the first use must ask");
    };
    assert!(decision_key.starts_with("secret/"));
    // A chat forwarding an answer is not the person: the refusal says so and nothing is recorded.
    let refused = crate::decisions::answer(
        &mut conn,
        "",
        &decision_key,
        "Once",
        Some("chat:chat-1".into()),
        bench.now + 1,
    )
    .unwrap_err();
    assert_eq!(
        refused,
        "Only the person can approve a secret run. Ask them on their card."
    );
    let still = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap();
    assert_eq!(still.state, "open");
    assert!(still.answer.is_none());
    // So the run still waits, and there is no grant.
    assert!(matches!(
        prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now + 2).unwrap(),
        RunOutcome::Waiting { .. }
    ));
    assert!(grants_for(&conn, SCOPE_GLOBAL, NAME).unwrap().is_empty());
}

#[test]
fn only_the_persons_own_paths_settle_a_secret_card() {
    // The Inbox sends no answerer and the check cards `person`; the Needs sheet `user` and an agent's name do not settle it.
    for (by, settles) in [
        (None, true),
        (Some("user"), false),
        (Some("person"), true),
        (Some("chat:chat-1"), false),
        (Some("Tally"), false),
        (Some("worker-1"), false),
    ] {
        let bench = Bench::new();
        let mut conn = bench.store.lock_conn().unwrap();
        save_value(
            &bench.vault,
            &conn,
            SCOPE_GLOBAL,
            NAME,
            None,
            VALUE,
            bench.now,
        )
        .unwrap();
        let RunOutcome::Waiting { decision_key, .. } =
            prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now).unwrap()
        else {
            panic!("the first use must ask");
        };
        let out = crate::decisions::answer(
            &mut conn,
            "",
            &decision_key,
            "Once",
            by.map(str::to_string),
            bench.now + 1,
        );
        if !settles {
            assert_eq!(
                out.unwrap_err(),
                "Only the person can approve a secret run. Ask them on their card.",
                "{by:?}"
            );
        }
        crate::decisions::answer(&mut conn, "", &decision_key, "Once", None, bench.now + 2)
            .unwrap();
        assert!(
            matches!(
                prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now + 3).unwrap(),
                RunOutcome::Granted { .. }
            ),
            "{by:?} then the person must grant"
        );
    }
}

#[test]
fn the_person_answering_through_their_own_path_still_grants() {
    for by in [None, Some("person".to_string())] {
        let bench = Bench::new();
        let mut conn = bench.store.lock_conn().unwrap();
        save_value(
            &bench.vault,
            &conn,
            SCOPE_GLOBAL,
            NAME,
            None,
            VALUE,
            bench.now,
        )
        .unwrap();
        let RunOutcome::Waiting { decision_key, .. } =
            prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now).unwrap()
        else {
            panic!("the first use must ask");
        };
        crate::decisions::answer(
            &mut conn,
            "",
            &decision_key,
            "Once",
            by.clone(),
            bench.now + 1,
        )
        .unwrap();
        assert!(
            matches!(
                prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now + 2).unwrap(),
                RunOutcome::Granted { .. }
            ),
            "{by:?} must grant"
        );
    }
}

#[test]
fn an_answered_secret_row_not_answered_by_the_person_is_never_a_grant() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    let RunOutcome::Waiting { decision_key, .. } =
        prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now).unwrap()
    else {
        panic!("the first use must ask");
    };
    // A row answered any other way (a build before the guard, or a rogue write): it is treated as not answered.
    conn.execute(
        "UPDATE decisions SET state = 'answered', answer = 'Once', answered_by = 'chat:chat-1', answered_at = ?1 \
         WHERE project = '' AND decision_key = ?2",
        rusqlite::params![bench.now + 1, decision_key],
    )
    .unwrap();
    assert!(matches!(
        prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now + 2).unwrap(),
        RunOutcome::Waiting { .. }
    ));
    assert!(grants_for(&conn, SCOPE_GLOBAL, NAME).unwrap().is_empty());
    // Nothing was deleted either: the person's own answer can still land on that row.
    assert!(crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .is_some());
    crate::decisions::answer(&mut conn, "", &decision_key, "Once", None, bench.now + 3).unwrap();
    assert!(matches!(
        prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now + 4).unwrap(),
        RunOutcome::Granted { .. }
    ));
}

#[test]
fn a_once_answer_for_one_mono_is_not_spent_by_another() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        NAME,
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    let RunOutcome::Waiting { decision_key, .. } =
        prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now).unwrap()
    else {
        panic!("the first use must ask");
    };
    // The person answered the card Tally's first run put up.
    crate::decisions::answer(&mut conn, "", &decision_key, "Once", None, bench.now + 1).unwrap();
    // Another Mono never gets that answer as its own run.
    assert!(matches!(
        prepare_run(&bench.vault, &mut conn, run_request("Other"), bench.now + 2).unwrap(),
        RunOutcome::Waiting { .. }
    ));
    assert!(grants_for(&conn, SCOPE_GLOBAL, NAME)
        .unwrap()
        .iter()
        .all(|grant| grant.subject_id != "Other"));
    // Tally's run is the one the answer was for.
    assert!(matches!(
        prepare_run(&bench.vault, &mut conn, run_request("Tally"), bench.now + 3).unwrap(),
        RunOutcome::Granted { .. }
    ));
}

#[test]
fn a_worker_asking_for_itself_is_refused_with_the_first_mate_reason() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    // A running delegation whose child is chat-1 makes it a worker (one level beneath its first mate).
    crate::delegations::record(
        &mut conn,
        crate::delegations::RecordInput {
            owner_session: "lead".into(),
            request_id: "req-1".into(),
            child_session: "chat-1".into(),
            ..Default::default()
        },
        bench.now,
    )
    .unwrap();
    let refused =
        worker::prepare(&bench.vault, &mut conn, worker_request(), bench.now).unwrap_err();
    assert!(refused.contains("first mate"), "{refused}");
    assert_eq!(
        refused,
        crate::decisions::check_may_ask(&conn, "chat-1").unwrap_err()
    );
}

// ---- a worker's approval survives a keychain that will not answer yet (fix round 1, item G) ----------------------------

/// A store whose first reads are refused, like a system prompt nobody has clicked yet, and then answer.
struct Flaky {
    inner: Memory,
    refuse_reads: std::sync::atomic::AtomicUsize,
}

impl Vault for Flaky {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        use std::sync::atomic::Ordering;
        if self
            .refuse_reads
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok()
        {
            return Err("Not now. Your keychain didn't give the key. Try again.".into());
        }
        self.inner.read(service, account)
    }

    fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        self.inner.write(service, account, value)
    }

    fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
        self.inner.remove(service, account)
    }
}

fn armed_for(bench: &Bench, vault: &dyn Vault, session: &str) {
    let mut conn = bench.store.lock_conn().unwrap();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        NAME,
        "mono",
        "Tally",
        "worker:claude",
        "",
        "worker:claude",
        "always",
        bench.now,
    )
    .unwrap();
    let worker::WorkerOutcome::Ready { secrets } =
        worker::prepare(vault, &mut conn, worker_request(), bench.now).unwrap()
    else {
        panic!("the grant is there");
    };
    worker::arm(session, secrets);
}

fn env_of(cmd: &Command) -> Vec<(String, String)> {
    cmd.get_envs()
        .filter_map(|(key, value)| {
            Some((
                key.to_string_lossy().into_owned(),
                value?.to_string_lossy().into_owned(),
            ))
        })
        .collect()
}

#[test]
fn a_keychain_that_will_not_answer_yet_does_not_burn_the_approval() {
    let bench = Bench::new();
    let flaky = Flaky {
        inner: Memory::new(),
        refuse_reads: std::sync::atomic::AtomicUsize::new(0),
    };
    {
        let conn = bench.store.lock_conn().unwrap();
        save_value(&flaky, &conn, SCOPE_GLOBAL, NAME, None, VALUE, bench.now).unwrap();
    }
    armed_for(&bench, &flaky, "worker-retry-1");
    // The keychain says "not now" the first time.
    flaky
        .refuse_reads
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let mut first = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    let why = worker::apply_to_child(
        "worker-retry-1",
        &flaky,
        &mut first,
        &bench.store,
        bench.now,
    )
    .unwrap_err();
    assert!(why.contains("Try again"), "{why}");
    assert_eq!(env_of(&first), vec![], "nothing was put in the child");
    // The approval is still there: the same spawn, tried again, gets the key.
    let mut second = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    worker::apply_to_child(
        "worker-retry-1",
        &flaky,
        &mut second,
        &bench.store,
        bench.now,
    )
    .unwrap();
    assert_eq!(
        env_of(&second),
        vec![("STRIPE_API_KEY".to_string(), VALUE.to_string())]
    );
    // And now it is spent: a third spawn of the same session gets nothing without a fresh approval.
    let mut third = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    worker::apply_to_child(
        "worker-retry-1",
        &flaky,
        &mut third,
        &bench.store,
        bench.now,
    )
    .unwrap();
    assert_eq!(env_of(&third), vec![]);
    worker::forget("worker-retry-1");
}

#[test]
fn a_second_secret_that_cannot_be_read_leaves_the_first_out_of_the_child_too() {
    let bench = Bench::new();
    let flaky = Flaky {
        inner: Memory::new(),
        refuse_reads: std::sync::atomic::AtomicUsize::new(0),
    };
    {
        let conn = bench.store.lock_conn().unwrap();
        save_value(&flaky, &conn, SCOPE_GLOBAL, NAME, None, VALUE, bench.now).unwrap();
        save_value(
            &flaky,
            &conn,
            SCOPE_GLOBAL,
            "resend-key",
            None,
            "re_live_abcdef012345",
            bench.now,
        )
        .unwrap();
    }
    let armed = |name: &str, env: &str| worker::ArmedSecret {
        scope: SCOPE_GLOBAL.into(),
        name: name.into(),
        env: env.into(),
        version: 1,
        mono: "Tally".into(),
        executable: "claude".into(),
    };
    worker::arm(
        "worker-retry-2",
        vec![
            armed(NAME, "STRIPE_API_KEY"),
            armed("resend-key", "RESEND_API_KEY"),
        ],
    );
    // The first read works, the second is refused.
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    struct SecondFails<'a>(&'a Flaky, std::sync::atomic::AtomicUsize);
    impl Vault for SecondFails<'_> {
        fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            if self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                return Err("Not now. Your keychain didn't give the key. Try again.".into());
            }
            self.0.read(service, account)
        }
        fn write(&self, s: &str, a: &str, v: &str) -> Result<(), String> {
            self.0.write(s, a, v)
        }
        fn remove(&self, s: &str, a: &str) -> Result<bool, String> {
            self.0.remove(s, a)
        }
    }
    let wrapped = SecondFails(&flaky, std::sync::atomic::AtomicUsize::new(0));
    assert!(worker::apply_to_child(
        "worker-retry-2",
        &wrapped,
        &mut cmd,
        &bench.store,
        bench.now
    )
    .is_err());
    assert_eq!(
        env_of(&cmd),
        vec![],
        "a half-applied environment is never left behind"
    );
    // Retried, both go in.
    let mut again = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    worker::apply_to_child(
        "worker-retry-2",
        &wrapped,
        &mut again,
        &bench.store,
        bench.now,
    )
    .unwrap();
    assert_eq!(env_of(&again).len(), 2);
    worker::forget("worker-retry-2");
}

#[test]
fn a_secret_that_changed_since_the_approval_is_refused_and_the_approval_is_dropped() {
    let bench = Bench::new();
    {
        let conn = bench.store.lock_conn().unwrap();
        save_value(
            &bench.vault,
            &conn,
            SCOPE_GLOBAL,
            NAME,
            None,
            VALUE,
            bench.now,
        )
        .unwrap();
    }
    armed_for(&bench, &bench.vault, "worker-rotated");
    {
        let conn = bench.store.lock_conn().unwrap();
        rotate(
            &bench.vault,
            &conn,
            SCOPE_GLOBAL,
            NAME,
            "sk_live_a_new_value_0000",
            bench.now + 1,
        )
        .unwrap();
    }
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    let why = worker::apply_to_child(
        "worker-rotated",
        &bench.vault,
        &mut cmd,
        &bench.store,
        bench.now + 2,
    )
    .unwrap_err();
    assert_eq!(why, "That secret changed. Ask for it again.");
    assert_eq!(env_of(&cmd), vec![]);
    // A permanent refusal is not kept: the stale approval cannot be used by a later spawn.
    let mut later = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    worker::apply_to_child(
        "worker-rotated",
        &bench.vault,
        &mut later,
        &bench.store,
        bench.now + 3,
    )
    .unwrap();
    assert_eq!(env_of(&later), vec![]);
}

#[test]
fn a_workers_spawn_reads_the_keychain_with_the_database_lock_free() {
    // The Keychain may show a system prompt; while it is open, no database writer in the app may be stalled behind it.
    struct Probe {
        inner: Memory,
        store: std::sync::Arc<SessionStore>,
        free: std::sync::Mutex<Vec<bool>>,
    }
    impl Vault for Probe {
        fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            let store = self.store.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _guard = store.lock_conn();
                let _ = tx.send(());
            });
            let free = rx
                .recv_timeout(std::time::Duration::from_millis(1_500))
                .is_ok();
            self.free.lock().unwrap().push(free);
            self.inner.read(service, account)
        }
        fn write(&self, s: &str, a: &str, v: &str) -> Result<(), String> {
            self.inner.write(s, a, v)
        }
        fn remove(&self, s: &str, a: &str) -> Result<bool, String> {
            self.inner.remove(s, a)
        }
    }
    let store = std::sync::Arc::new(SessionStore::open_in_memory().unwrap());
    let probe = Probe {
        inner: Memory::new(),
        store: store.clone(),
        free: std::sync::Mutex::new(Vec::new()),
    };
    {
        let conn = store.lock_conn().unwrap();
        save_value(&probe, &conn, SCOPE_GLOBAL, NAME, None, VALUE, 1).unwrap();
        worker::arm(
            "worker-probe",
            vec![worker::ArmedSecret {
                scope: SCOPE_GLOBAL.into(),
                name: NAME.into(),
                env: "STRIPE_API_KEY".into(),
                version: 1,
                mono: "Tally".into(),
                executable: "claude".into(),
            }],
        );
    }
    probe.free.lock().unwrap().clear();
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    worker::apply_to_child("worker-probe", &probe, &mut cmd, &store, 2).unwrap();
    assert_eq!(*probe.free.lock().unwrap(), vec![true]);
    assert_eq!(
        env_of(&cmd),
        vec![("STRIPE_API_KEY".to_string(), VALUE.to_string())]
    );
    worker::forget("worker-probe");
}

// ---- fix round 3 (M2, M3): the base64 of the key at every alignment is scrubbed; a worker's card says its transcript
// keeps what it prints.

#[test]
fn base64_of_the_key_at_every_alignment_is_masked() {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let value = "sk_live_51NxAbCdEfGhIjKl";
    for prefix in ["", "u", "user:", "KEY:"] {
        let encoded = STANDARD.encode(format!("{prefix}{value}"));
        // Characters 8..24 are fixed by the key alone, whatever came before it (`curl -u`, `Authorization: Basic`).
        let window = &encoded[8..24];
        let masked = scrub::mask(&encoded, &scrub::needles(value));
        assert!(!masked.contains(window), "{prefix:?}: {masked}");
    }
}

#[test]
fn a_worker_card_says_its_transcript_keeps_what_it_prints() {
    let text = worker::worker_card_question("Tally", "Stripe API key", "your global keys");
    assert!(text.contains("transcript"), "{text}");
}

#[test]
fn a_worker_card_says_its_ai_can_read_the_key_and_send_it_anywhere() {
    // Round 4 (N8): the card names what the worker's AI can do with the key, before the person answers.
    let text = worker::worker_card_question("Tally", "Stripe API key", "your global keys");
    assert!(text.contains("can read the key"), "{text}");
    assert!(text.contains("send it anywhere"), "{text}");
}
