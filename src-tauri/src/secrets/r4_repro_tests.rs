//! Round 5: the outcomes the re-review asked for. The review branch was not in this clone, so these tests stand in for
//! `r4_repro_tests.rs` on that branch. Each one fails on the round-4 code and passes after the fix.

use super::store::Memory;
use super::*;
use crate::session_store::SessionStore;

const VALUE: &str = "sk_live_51NxAbCdEfGhIjKl";
const NOW: i64 = 1_700_000_000_000;

struct Bench {
    store: SessionStore,
    vault: Memory,
}

impl Bench {
    fn new() -> Self {
        let bench = Self {
            store: SessionStore::open_in_memory().unwrap(),
            vault: Memory::new(),
        };
        let conn = bench.store.lock_conn().unwrap();
        save_value(
            &bench.vault,
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            None,
            VALUE,
            NOW,
        )
        .unwrap();
        drop(conn);
        bench
    }
}

fn request(command: &[&str]) -> RunRequest {
    RunRequest {
        chat: "chat-1".into(),
        mono: Some("mono-1".into()),
        project: None,
        name: "stripe-api-key".into(),
        env: "STRIPE_API_KEY".into(),
        command: command.iter().map(|word| word.to_string()).collect(),
        cwd: None,
        timeout_seconds: None,
    }
}

#[test]
fn a_secret_card_offers_once_and_no_only() {
    assert_eq!(
        approval_options(true, true),
        vec!["Once".to_string(), "No".to_string()]
    );
    assert_eq!(
        approval_options(false, true),
        vec!["Once".to_string(), "No".to_string()]
    );
}

#[test]
fn curl_and_wget_are_not_offered_always_and_the_card_says_they_read_config() {
    let bench = Bench::new();
    let conn = bench.store.lock_conn().unwrap();
    assert!(
        !always_allowed_for(&conn, "/usr/bin/curl"),
        "curl reads config the card does not show"
    );
    assert!(
        !always_allowed_for(&conn, "/usr/bin/wget"),
        "wget reads config and can run a helper"
    );
    assert!(
        !always_allowed_for(&conn, "/usr/bin/true"),
        "Always is not offered for any program"
    );
    drop(conn);
    let mut conn = bench.store.lock_conn().unwrap();
    let outcome = prepare_run(
        &bench.vault,
        &mut conn,
        request(&[curl_program(), "https://example.test"]),
        NOW,
    )
    .unwrap();
    let RunOutcome::Waiting { decision_key, .. } = outcome else {
        panic!("the first curl run must ask");
    };
    let card = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap();
    assert_eq!(card.options, vec!["Once".to_string(), "No".to_string()]);
    assert!(
        card.question
            .contains("This program can read config files and run helpers."),
        "{}",
        card.question
    );
    // `--engine` (Linux) and `-K` are the same hole: the program is curl, so Always is not a choice.
    assert!(!card.question.contains("Always"));
}

#[test]
fn an_always_answer_and_a_stored_always_grant_do_not_run_the_command() {
    let bench = Bench::new();
    let (program, identity) = pin_program(harmless_program(), None, None).unwrap();
    let command = vec![program.clone(), "customers".to_string()];
    let fingerprint = run_fingerprint(
        &program,
        &identity,
        "STRIPE_API_KEY",
        None,
        &command,
        TIMEOUT_DEFAULT,
    );
    let mut conn = bench.store.lock_conn().unwrap();
    let err = put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        &program,
        &identity,
        &fingerprint,
        "always",
        NOW,
    )
    .unwrap_err();
    assert!(
        err.contains("asks every time") || err.contains("Always"),
        "{err}"
    );
    conn.execute(
        "INSERT INTO secret_grants (scope, name, subject_kind, subject_id, executable, mode, created_at, identity, fingerprint)
         VALUES ('global', 'stripe-api-key', 'mono', 'mono-1', ?1, 'always', ?2, ?3, ?4)",
        rusqlite::params![program, NOW, identity, fingerprint],
    )
    .unwrap();
    let outcome = prepare_run(
        &bench.vault,
        &mut conn,
        request(&[harmless_program(), "customers"]),
        NOW + 1,
    )
    .unwrap();
    assert!(
        matches!(outcome, RunOutcome::Waiting { .. }),
        "a stored Always grant must not skip the card: {outcome:?}"
    );
}

#[test]
fn a_homebrew_program_is_told_it_can_read_config_even_when_it_is_not_curl() {
    let text = run_question(
        "Tally",
        "Stripe key",
        "your global keys",
        &["/opt/homebrew/bin/true".to_string(), "x".to_string()],
        false,
        false,
        "STRIPE_API_KEY",
        None,
    )
    .unwrap();
    assert!(
        text.contains("This program can read config files and run helpers."),
        "{text}"
    );
    let plain = run_question(
        "Tally",
        "Stripe key",
        "your global keys",
        &["/usr/bin/true".to_string(), "x".to_string()],
        false,
        false,
        "STRIPE_API_KEY",
        None,
    )
    .unwrap();
    assert!(
        !plain.contains("can read config files"),
        "a system program that is not curl or wget does not get that line: {plain}"
    );
}

#[test]
fn answering_a_secret_card_without_the_version_that_was_read_is_refused() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    let outcome = prepare_run(
        &bench.vault,
        &mut conn,
        request(&[harmless_program(), "x"]),
        NOW,
    )
    .unwrap();
    let RunOutcome::Waiting { decision_key, .. } = outcome else {
        panic!("a card");
    };
    let err =
        crate::decisions::answer(&mut conn, "", &decision_key, "Once", None, NOW + 1).unwrap_err();
    assert!(
        err.contains("Read the card again"),
        "a missing version must be refused inside the store: {err}"
    );
    let still = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap();
    assert_eq!(still.state, "open");
}

#[cfg(unix)]
#[test]
fn a_path_that_cannot_be_resolved_counts_as_writable() {
    assert!(
        run::has_user_writable_component(std::path::Path::new("/usr/bin/monocode-missing-wp92")),
        "a path that cannot be resolved is not treated as safe"
    );
    assert!(
        !run::has_user_writable_component(std::path::Path::new("/usr/bin/true")),
        "/usr/bin/true is not a folder the account writes"
    );
}

#[cfg(unix)]
#[test]
fn the_secret_childs_path_starts_with_the_system_folders() {
    let path = run::child_path();
    let first = std::env::split_paths(&path).next().expect("a PATH");
    assert_eq!(first, std::path::Path::new("/usr/bin"));
    assert_eq!(
        crate::connectors::launch::SAFE_PATH,
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        "connector launches stay Homebrew-first"
    );
}

#[test]
fn a_crashed_runs_home_under_the_temporary_folder_is_removed_at_startup() {
    let temp = std::env::temp_dir();
    let left = temp.join(format!(
        "monocode-run-home-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let kept = temp.join(format!(
        "monocode-not-a-home-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&left).unwrap();
    std::fs::create_dir_all(&kept).unwrap();
    run::remove_leftover_run_homes();
    assert!(!left.exists(), "a leftover run home is removed");
    assert!(kept.exists(), "a folder with another name is kept");
    let _ = std::fs::remove_dir_all(&kept);
}
