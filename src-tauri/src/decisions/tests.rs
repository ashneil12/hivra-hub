//! Hivra WP-14's "Done when": a worker's question reaches its first mate, not the person; the same decision key asked
//! twice gives one decision; answering releases two waiting delegations; the fan-out cap refuses with a reason.

use super::*;
use crate::delegations::{record, set_question, RecordInput};
use crate::firstmate::status::{status_of, Status};
use crate::session_store::SessionStore;
use crate::steering::{pending, PENDING};

fn store() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn launch(owner: &str, request: &str, child: &str) -> RecordInput {
    RecordInput {
        owner_session: owner.into(),
        request_id: request.into(),
        child_session: child.into(),
        title: Some("Clean up old sessions".into()),
        brief: Some("Remove stale sessions".into()),
        ..Default::default()
    }
}

fn ask_input(asked_by: &str, key: &str, tasks: &[&str]) -> AskInput {
    AskInput {
        asked_by: asked_by.into(),
        asked_by_mono: None,
        project: Some("hivra".into()),
        key: key.into(),
        question: "Keep deleted sessions for 30 days, or delete them for good?".into(),
        options: vec!["Keep 30 days".into(), "Delete for good".into()],
        recommended: Some("Keep 30 days".into()),
        task_ids: tasks.iter().map(|t| t.to_string()).collect(),
    }
}

#[test]
fn a_worker_question_reaches_its_first_mate_not_the_person() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("fm", "r1", "worker"), 1).unwrap();
    let asked = set_question(&mut conn, &row.id, Some("Which API?".into()), None, 2)
        .unwrap()
        .row
        .unwrap();
    // Its question is its first mate's: the row reads as working, never as needing the person.
    assert_eq!(status_of(&asked).status, Status::Working);
    // The worker can't put it to the person itself.
    let err = ask(&mut conn, ask_input("worker", "which-api", &[]), 3).unwrap_err();
    assert!(err.contains("goes to it, not to the person"), "{err}");
    assert!(list(&conn, 10).unwrap().is_empty());
    // Its first mate can, and then the task waits on the person.
    let out = ask(&mut conn, ask_input("fm", "which-api", &[&row.id]), 4).unwrap();
    assert!(out.created);
    let waiting = delegations::get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(status_of(&waiting).status, Status::NeedsYou);
}

#[test]
fn a_first_mate_under_a_first_mate_asks_up_one_level() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    // The coding team briefed a Mono, which works for it: the Mono asks the coding team, not the person.
    record(&mut conn, launch("coding-team", "r1", "mono"), 1).unwrap();
    assert!(ask(&mut conn, ask_input("mono", "k", &[]), 2).is_err());
    assert!(ask(&mut conn, ask_input("coding-team", "k", &[]), 3).is_ok());
}

#[test]
fn the_same_key_asked_twice_gives_one_decision() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    let b = record(&mut conn, launch("fm", "r2", "w2"), 1).unwrap();
    let first = ask(&mut conn, ask_input("fm", "retention", &[&a.id]), 2).unwrap();
    assert!(first.created);
    let mut again = ask_input("fm", "retention", &[&a.id, &b.id]);
    again.question = "Something reworded".into();
    again.options = vec!["Yes".into(), "No".into()];
    again.recommended = None;
    let second = ask(&mut conn, again, 3).unwrap();
    assert!(!second.created);
    // Nothing about the question changed; only the new waiter joined.
    assert_eq!(second.decision.question, first.decision.question);
    assert_eq!(second.decision.options, first.decision.options);
    assert_eq!(second.decision.recommended.as_deref(), Some("Keep 30 days"));
    assert_eq!(second.added, vec![b.id.clone()]);
    assert_eq!(second.decision.waiting, vec![a.id.clone(), b.id.clone()]);
    // A third identical ask changes nothing at all.
    let third = ask(&mut conn, ask_input("fm", "retention", &[&a.id]), 4).unwrap();
    assert!(third.added.is_empty());
    assert_eq!(third.decision.version, second.decision.version);
    assert_eq!(list(&conn, 10).unwrap().len(), 1);
    // The same key in another project is another decision.
    let mut elsewhere = ask_input("fm", "retention", &[]);
    elsewhere.project = Some("exo".into());
    assert!(ask(&mut conn, elsewhere, 5).unwrap().created);
}

#[test]
fn answering_releases_two_waiting_delegations() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    let b = record(&mut conn, launch("fm", "r2", "w2"), 1).unwrap();
    set_question(&mut conn, &a.id, Some("Keep or delete?".into()), None, 2).unwrap();
    ask(&mut conn, ask_input("fm", "retention", &[&a.id, &b.id]), 3).unwrap();
    let asked = delegations::get(&conn, &a.id).unwrap().unwrap();
    assert_eq!(status_of(&asked).status, Status::NeedsYou);

    let out = answer(
        &mut conn,
        "hivra",
        "retention",
        "Keep 30 days",
        Some("user".into()),
        4,
    )
    .unwrap();
    assert!(out.applied);
    assert_eq!(out.released_tasks, vec![a.id.clone(), b.id.clone()]);
    let d = out.decision.unwrap();
    assert_eq!(
        (d.state.as_str(), d.answer.as_deref()),
        (ANSWERED, Some("Keep 30 days"))
    );
    // Each waiting worker, then the first mate that asked, has a message with the answer, stored to go in.
    let messages = pending(&conn).unwrap();
    let to: Vec<&str> = messages.iter().map(|m| m.child_session.as_str()).collect();
    assert_eq!(to, ["w1", "w2", "fm"]);
    assert!(messages
        .iter()
        .all(|m| m.state == PENDING && m.source == "decision" && m.text.contains("Keep 30 days")));
    // The question is its first mate's again: the task reads as working.
    let released = delegations::get(&conn, &a.id).unwrap().unwrap();
    assert_eq!(status_of(&released).status, Status::Working);

    // A second answer changes nothing and sends nothing.
    let again = answer(&mut conn, "hivra", "retention", "Delete for good", None, 5).unwrap();
    assert!(!again.applied);
    assert_eq!(
        again.decision.unwrap().answer.as_deref(),
        Some("Keep 30 days")
    );
    assert_eq!(pending(&conn).unwrap().len(), 3);

    // A task that joins after the answer gets it straight away.
    let c = record(&mut conn, launch("fm", "r3", "w3"), 6).unwrap();
    let late = ask(&mut conn, ask_input("fm", "retention", &[&c.id]), 7).unwrap();
    assert_eq!(late.released.len(), 1);
    assert_eq!(late.released[0].child_session, "w3");
}

#[test]
fn a_finished_task_is_not_released_and_bad_asks_are_refused() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    let other = record(&mut conn, launch("someone-else", "r2", "w2"), 1).unwrap();
    assert!(ask(&mut conn, ask_input("fm", "k", &[&other.id]), 2)
        .unwrap_err()
        .contains("isn't one of your tasks"));
    let mut one = ask_input("fm", "k", &[]);
    one.options = vec!["Only".into()];
    assert!(ask(&mut conn, one, 2).is_err());
    let mut bad_pick = ask_input("fm", "k", &[]);
    bad_pick.recommended = Some("Maybe".into());
    assert!(ask(&mut conn, bad_pick, 2)
        .unwrap_err()
        .contains("isn't one of the options"));
    let mut bad_key = ask_input("fm", "has spaces", &[]);
    bad_key.key = "has spaces".into();
    assert!(ask(&mut conn, bad_key, 2).is_err());
    let mut long = ask_input("fm", "k", &[]);
    long.question = "x".repeat(QUESTION_MAX + 1);
    assert!(ask(&mut conn, long, 2).unwrap_err().contains("at most"));

    ask(&mut conn, ask_input("fm", "k", &[&a.id]), 3).unwrap();
    crate::delegations::cancel(
        &mut conn,
        std::slice::from_ref(&a.id),
        Some("stop".into()),
        None,
        4,
    )
    .unwrap();
    let out = answer(&mut conn, "hivra", "k", "Keep 30 days", None, 5).unwrap();
    assert!(out.applied);
    assert!(out.released_tasks.is_empty());
    // Only the asker hears it.
    assert_eq!(out.released.len(), 1);
    assert_eq!(out.released[0].child_session, "fm");
    assert!(
        !answer(&mut conn, "hivra", "missing", "x", None, 6)
            .unwrap()
            .applied
    );
}

#[test]
fn the_fanout_cap_refuses_with_a_plain_reason() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    for i in 0..crate::firstmate::MAX_FANOUT {
        assert_eq!(crate::firstmate::check_fanout(&conn, "fm").unwrap(), i);
        record(
            &mut conn,
            launch("fm", &format!("r{i}"), &format!("w{i}")),
            1,
        )
        .unwrap();
    }
    let err = crate::firstmate::check_fanout(&conn, "fm").unwrap_err();
    assert!(err.contains("you already have 8 tasks running"), "{err}");
    assert!(err.contains("task_cancel"));
    // Another first mate is not held back.
    assert_eq!(crate::firstmate::check_fanout(&conn, "other").unwrap(), 0);
}

#[test]
fn an_answer_given_in_the_askers_chat_is_not_repeated_to_it() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    ask(&mut conn, ask_input("fm", "retention", &[&a.id]), 2).unwrap();
    let out = answer(
        &mut conn,
        "hivra",
        "retention",
        "Keep 30 days",
        Some("chat:fm".into()),
        3,
    )
    .unwrap();
    let to: Vec<&str> = out
        .released
        .iter()
        .map(|m| m.child_session.as_str())
        .collect();
    assert_eq!(to, ["w1"]);
}

#[test]
fn only_the_person_answers_an_irreversible_step() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let key = "irreversible/lead/task-1";
    ask(
        &mut conn,
        AskInput {
            question: "Deploy cannot be undone: it migrates the shared database.".into(),
            options: vec!["Approve".into(), "Send back".into()],
            recommended: Some("Send back".into()),
            ..ask_input("lead", key, &[])
        },
        2,
    )
    .unwrap();
    // A chat answering for the first mate cannot settle it, and neither can autopilot.
    for machine in [Some("chat:lead"), Some("autopilot")] {
        let refusal = answer(
            &mut conn,
            "hivra",
            key,
            "Approve",
            machine.map(str::to_string),
            3,
        )
        .unwrap_err();
        assert!(refusal.contains("Only the person answers"), "{refusal}");
    }
    // It is still open: a machine's answer did not settle it quietly.
    assert_eq!(get(&conn, "hivra", key).unwrap().unwrap().state, OPEN);
    // The person's own answer goes through, and the waiting worker hears it.
    let out = answer(
        &mut conn,
        "hivra",
        key,
        "Send back: use the staging database first",
        Some("user".into()),
        4,
    )
    .unwrap();
    assert!(out.applied);
    assert_eq!(
        out.decision.unwrap().answer.as_deref(),
        Some("Send back: use the staging database first")
    );
    // The lead that parked it hears the person's words.
    assert!(out.released.iter().any(|m| m.child_session == "lead"));
    // An ordinary decision is still answered by a chat on the first mate's behalf, as before.
    ask(&mut conn, ask_input("fm", "retention", &[]), 5).unwrap();
    assert!(
        answer(
            &mut conn,
            "hivra",
            "retention",
            "Keep 30 days",
            Some("chat:fm".into()),
            6
        )
        .unwrap()
        .applied
    );
}

#[test]
fn only_the_person_answers_a_fresh_eyes_review_and_the_app_may_close_it() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    for key in [
        "fresh-eyes/r1/00112233aabbccdd",
        "fresh-eyes-start/r1/00112233aabbccdd",
    ] {
        ask(
            &mut conn,
            AskInput {
                question: "Fresh-eyes review: waiting on you".into(),
                options: vec!["Approve".into(), "Edit plan".into(), "Skip once".into()],
                recommended: None,
                ..ask_input("lead", key, &[])
            },
            2,
        )
        .unwrap();
        // The chat that asked cannot take the question out of the person's Inbox, nor can anything else but the person.
        for machine in [
            Some("chat:lead"),
            Some("autopilot"),
            Some("chat:someone-else"),
        ] {
            let refusal = answer(
                &mut conn,
                "hivra",
                key,
                "Approve",
                machine.map(str::to_string),
                3,
            )
            .unwrap_err();
            assert!(
                refusal.contains("Only the person answers a fresh-eyes review"),
                "{refusal}"
            );
        }
        assert_eq!(
            get(&conn, "hivra", key).unwrap().unwrap().state,
            OPEN,
            "{key}"
        );
    }
    // The person, in either of the app's own answer paths, goes through.
    for (key, by) in [
        ("fresh-eyes/r1/00112233aabbccdd", Some("user")),
        ("fresh-eyes-start/r1/00112233aabbccdd", None),
    ] {
        assert!(
            answer(
                &mut conn,
                "hivra",
                key,
                "Approve",
                by.map(str::to_string),
                4
            )
            .unwrap()
            .applied,
            "{key}"
        );
    }
    // The app closes its own question when a brief is taken back, and tells the chat that asked nothing: it did it.
    let key = "fresh-eyes/r2/ffeeddccbbaa0011";
    ask(&mut conn, ask_input("lead", key, &[]), 5).unwrap();
    let out = answer(
        &mut conn,
        "hivra",
        key,
        "Cancelled by the chat that asked.",
        Some(APP_CLOSER.into()),
        6,
    )
    .unwrap();
    assert!(out.applied);
    assert!(out.released.is_empty(), "{:?}", out.released);
    assert_eq!(
        get(&conn, "hivra", key)
            .unwrap()
            .unwrap()
            .answered_by
            .as_deref(),
        Some(APP_CLOSER)
    );
    // The app's word is not a way round for any other key: an irreversible step is still the person's alone.
    let hard = "irreversible/lead/task-9";
    ask(&mut conn, ask_input("lead", hard, &[]), 7).unwrap();
    let refusal = answer(
        &mut conn,
        "hivra",
        hard,
        "Approve",
        Some(APP_CLOSER.into()),
        8,
    )
    .unwrap_err();
    assert!(
        refusal.contains("Only the person answers an irreversible step"),
        "{refusal}"
    );
}

#[test]
fn a_chat_cannot_settle_a_person_only_key_by_changing_its_case_or_width() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    // A chat can ask under any spelling, so a person-only key can be stored in mixed case. The check reads the stored
    // key folded (trimmed, NFKC, lower-case), so the stored key and the checked key cannot differ.
    let stored = [
        "FRESH-EYES/r3/00112233aabbccdd",
        "irreversible/lead/task-4",
        "Irreversible/lead/task-5",
    ];
    for key in stored {
        ask(&mut conn, ask_input("lead", key, &[]), 2).unwrap();
    }
    let spellings = [
        (
            "Irreversible/lead/task-4",
            "Only the person answers an irreversible step",
        ),
        (
            " irreversible/lead/task-4",
            "Only the person answers an irreversible step",
        ),
        (
            "ｉｒｒｅｖｅｒｓｉｂｌｅ/lead/task-4",
            "Only the person answers an irreversible step",
        ),
        (
            "irreversible／lead/task-4",
            "Only the person answers an irreversible step",
        ),
        (
            "Irreversible/lead/task-5",
            "Only the person answers an irreversible step",
        ),
        (
            "IRREVERSIBLE/lead/task-5",
            "Only the person answers an irreversible step",
        ),
        (
            "FRESH-EYES/r3/00112233aabbccdd",
            "Only the person answers a fresh-eyes review",
        ),
        (
            "Fresh-Eyes/r3/00112233aabbccdd",
            "Only the person answers a fresh-eyes review",
        ),
        (
            "ｆｒｅｓｈ-ｅｙｅｓ/r3/00112233aabbccdd",
            "Only the person answers a fresh-eyes review",
        ),
        (
            "fresh-eyes／r3/00112233aabbccdd",
            "Only the person answers a fresh-eyes review",
        ),
    ];
    for (key, why) in spellings {
        for machine in [Some("chat:lead"), Some("autopilot")] {
            let refusal = answer(
                &mut conn,
                "hivra",
                key,
                "Approve",
                machine.map(str::to_string),
                3,
            )
            .unwrap_err();
            assert!(refusal.contains(why), "{key}: {refusal}");
        }
    }
    for key in stored {
        assert_eq!(
            get(&conn, "hivra", key).unwrap().unwrap().state,
            OPEN,
            "{key}"
        );
    }
    // The person still answers a mixed-case decision as it is stored: rows written before this fix stay answerable.
    let out = answer(
        &mut conn,
        "hivra",
        "FRESH-EYES/r3/00112233aabbccdd",
        "Approve",
        Some("user".into()),
        4,
    )
    .unwrap();
    assert!(out.applied);
    // An ordinary key is still answered by a chat on the first mate's behalf, whatever its case.
    ask(&mut conn, ask_input("fm", "Retention-Policy", &[]), 5).unwrap();
    assert!(
        answer(
            &mut conn,
            "hivra",
            "Retention-Policy",
            "Keep 30 days",
            Some("chat:fm".into()),
            6
        )
        .unwrap()
        .applied
    );
}

#[test]
fn invisible_format_characters_and_unicode_space_do_not_change_a_person_only_key() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    ask(
        &mut conn,
        ask_input("lead", "irreversible/lead/task-6", &[]),
        2,
    )
    .unwrap();
    // Zero-width and other format characters (Unicode Cf and default-ignorable) are invisible: they are dropped before the
    // prefix check, and so is any Unicode space that trim removes.
    let spellings = [
        "irre\u{200B}versible/lead/task-6",
        "\u{200B}irreversible/lead/task-6",
        "irreversible\u{200C}/lead/task-6",
        "irreversible/lead\u{200D}/task-6",
        "irreversible\u{FEFF}/lead/task-6",
        "\u{00AD}irreversible/lead/task-6",
        "irre\u{2060}versible/lead/task-6",
        "\u{FE0F}irreversible/lead/task-6",
        "\u{200B} \u{200B}irreversible/lead/task-6",
        "\u{00A0}irreversible/lead/task-6",
        "\u{3000}irreversible/lead/task-6",
        "\u{2028}irreversible/lead/task-6",
        "\u{0085}irreversible/lead/task-6",
        "fresh\u{00AD}-eyes/r9/00112233aabbccdd",
    ];
    for key in spellings {
        assert_eq!(
            fold_key(key),
            fold_key(key).trim(),
            "{key:?} folds to a padded key"
        );
        assert!(
            person_only(key, Some("chat:lead")).is_some(),
            "{key:?} is not person-only"
        );
    }
    assert_eq!(fold_key("irre\u{200B}versible/x"), "irreversible/x");
    // A chat answer in any of these spellings is refused, and the decision stays open.
    for key in &spellings[..spellings.len() - 1] {
        let refusal = answer(
            &mut conn,
            "hivra",
            key,
            "Approve",
            Some("chat:lead".into()),
            3,
        )
        .unwrap_err();
        assert!(
            refusal.contains("Only the person answers"),
            "{key:?}: {refusal}"
        );
    }
    assert_eq!(
        get(&conn, "hivra", "irreversible/lead/task-6")
            .unwrap()
            .unwrap()
            .state,
        OPEN
    );
}
