//! Review of #246, round 1: one "Once" answer lets one run through.
//!
//! Two runs of the same command, from the same Mono, can both read the answered Once card before either writes its
//! grant. The first spends the card. The second then writes its own once grant, spends it at once, finds the card it
//! read already gone (its version-checked delete clears nothing), and still commits and is granted. The card it relied
//! on no longer exists, so it must wait (the next check asks again) instead of running a second time.

use super::store::Memory;
use super::*;
use crate::session_store::SessionStore;

const VALUE: &str = "sk_live_51NxAbCdEfGhIjKl";
const NOW: i64 = 1_700_000_000_000;

fn run_request(mono: &str) -> RunRequest {
    RunRequest {
        chat: "chat-1".into(),
        mono: Some(mono.into()),
        project: None,
        name: "stripe-api-key".into(),
        env: "STRIPE_API_KEY".into(),
        command: vec![harmless_program().into(), "customers".into(), "list".into()],
        cwd: None,
        timeout_seconds: None,
    }
}

#[test]
fn a_once_card_another_run_already_spent_does_not_grant_a_second_run() {
    let store = SessionStore::open_in_memory().unwrap();
    let vault = Memory::new();
    {
        let conn = store.lock_conn().unwrap();
        save_value(
            &vault,
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            None,
            VALUE,
            NOW,
        )
        .unwrap();
    }
    let mut conn = store.lock_conn().unwrap();
    let RunOutcome::Waiting { decision_key, .. } =
        prepare_run(&vault, &mut conn, run_request("mono-1"), NOW).unwrap()
    else {
        panic!("the first run must ask");
    };
    let seen = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap()
        .version;
    crate::decisions::answer_seen(
        &mut conn,
        "",
        &decision_key,
        "Once",
        Some("person".into()),
        Some(seen),
        NOW + 1,
    )
    .unwrap();
    // The other run spends the card after this run has read it and before this run's grant is written: the card and
    // its binding are gone by the time this run clears them.
    conn.execute_batch(
        "CREATE TRIGGER another_run_spent_the_once_card
         AFTER INSERT ON secret_grants
         BEGIN
           DELETE FROM decisions;
           DELETE FROM secret_card_bindings;
         END;",
    )
    .unwrap();
    let outcome = prepare_run(&vault, &mut conn, run_request("mono-1"), NOW + 2).unwrap();
    assert!(
        !matches!(outcome, RunOutcome::Granted { .. }),
        "one Once answer let a second run through after the card it read was already spent: {outcome:?}"
    );
    assert!(
        grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .is_empty(),
        "no grant may be left behind"
    );
}
