//! SC-6 (spec 4i): property tests for `derive_status`.
//!
//! The rule that must always hold: a failed gate never reads as done, and an unsure or still-pending verdict never reads
//! as passed. The example tests in `tests.rs` pick one row per state; these draw rows from the whole space (every state,
//! every verdict, every stall kind, sent-back lines in any shape, usage-limit fields) and check the rule on all of them.

use proptest::prelude::*;
use serde_json::{json, Value};

use super::{
    derive_status, is_done, sent_back_on, status_of, GateVerdict, Status, QUESTION_FOR_FIRST_MATE,
    QUESTION_FOR_PERSON,
};
use crate::delegations::{Delegation, CANCELLED, COMPLETED, FAILED, QUESTION, RUNNING};

/// 64 cases a run, or whatever `PROPTEST_CASES` says (an explicit `cases` would override the variable).
fn config() -> ProptestConfig {
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 64;
    }
    config
}

/// Free text as a log, a reason or a question can carry it: empty, blank, long, unicode, control characters.
fn text() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => "[a-zA-Z0-9 .,:'-]{0,40}",
        2 => any::<String>(),
        1 => Just(String::new()),
        1 => Just("   ".to_string()),
        1 => "\\PC{150,260}",
        1 => "[\\x00-\\x1f\\x7f]{1,3}[a-z ]{0,8}",
    ]
}

fn state() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(RUNNING.to_string()),
        Just(QUESTION.to_string()),
        Just(COMPLETED.to_string()),
        Just(FAILED.to_string()),
        Just(CANCELLED.to_string()),
        // A state this build doesn't know.
        text(),
    ]
}

fn verdict() -> impl Strategy<Value = GateVerdict> {
    prop_oneof![
        Just(GateVerdict::NotRequired),
        Just(GateVerdict::Pending),
        Just(GateVerdict::Passed),
        Just(GateVerdict::Failed),
        Just(GateVerdict::Unsure),
    ]
}

/// A stored verdict word: the four real ones, near misses of "passed" (case, padding, a suffix), or anything else a
/// disk or an import could hold.
fn stored_word() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => prop::sample::select(vec![
            "passed", "failed", "unsure", "pending", "Passed", "PASSED", " passed", "passed\n",
            "passed-ish", "",
        ])
        .prop_map(String::from),
        1 => text(),
    ]
}

/// The verdict as the row's column holds it: a word, or none (no gates apply).
fn stored_verdict() -> impl Strategy<Value = Option<String>> {
    prop::option::of(stored_word())
}

fn stall_kind() -> impl Strategy<Value = Option<String>> {
    prop::option::of(prop_oneof![
        Just("blocked".to_string()),
        Just("quiet".to_string()),
        Just("loop".to_string()),
        Just("idle".to_string()),
        text(),
    ])
}

fn question_owner() -> impl Strategy<Value = Option<String>> {
    prop::option::of(prop_oneof![
        Just(QUESTION_FOR_PERSON.to_string()),
        Just(QUESTION_FOR_FIRST_MATE.to_string()),
        text(),
    ])
}

fn error_class() -> impl Strategy<Value = Option<String>> {
    prop::option::of(prop_oneof![Just("usage_limit".to_string()), text()])
}

fn log_entry() -> impl Strategy<Value = Value> {
    prop_oneof![
        text().prop_map(|summary| json!({ "event": "gates", "summary": summary })),
        // A real send-back line, in every shape the free text can give it.
        text().prop_map(|reason| json!({ "event": "gates", "summary": format!("Sent back: {reason}\nmore lines") })),
        text().prop_map(|reason| json!({ "event": "gates", "summary": format!("Sent back: {reason}") })),
        prop_oneof![
            Just("self:worker".to_string()),
            Just("owner:lead".to_string()),
            text()
        ]
        .prop_map(|by| json!({ "event": "stalled", "kind": "blocked", "by": by })),
        Just(json!({ "event": "stalled", "kind": "blocked" })),
        Just(json!({ "event": "superseded" })),
        Just(json!({ "event": "gates", "summary": 5 })),
        Just(json!({ "event": "gates" })),
        Just(json!("not an object")),
        Just(Value::Null),
    ]
}

/// A delegation row drawn from the whole space of the fields `derive_status` reads.
fn delegation() -> impl Strategy<Value = Delegation> {
    (
        state(),
        stall_kind(),
        prop::option::of(text()),
        question_owner(),
        prop::option::of(text()),
        (
            error_class(),
            prop::option::of(text()),
            prop::option::of(any::<bool>()),
            prop::option::of(any::<i64>()),
        ),
        stored_verdict(),
        prop::collection::vec(log_entry(), 0..6),
    )
        .prop_map(
            |(
                state,
                stall_kind,
                stall_reason,
                question_owner,
                pending_question,
                (error_class, error, retryable, resets_at),
                gate_verdict,
                log,
            )| Delegation {
                id: "t-1".into(),
                owner_session: "owner".into(),
                owner_mono: None,
                batch_id: None,
                parent_id: None,
                root_id: "t-1".into(),
                child_session: "child".into(),
                request_id: "r-1".into(),
                generation: 1,
                project: None,
                title: None,
                brief: None,
                goal: None,
                ask_ids: Vec::new(),
                state,
                error_class,
                error,
                retryable,
                resets_at,
                result: None,
                pending_question,
                delivery: "pending".into(),
                delivery_message: None,
                created_at: 0,
                run_started_at: 0,
                updated_at: 0,
                settled_at: None,
                log,
                review_required: false,
                self_review: None,
                version: 1,
                mirrored_version: 0,
                mirror_error: None,
                follow: None,
                stall_kind,
                stall_reason,
                stalled_at: None,
                question_owner,
                gate_verdict,
                report: None,
                status: Status::Working,
                status_notice: None,
            },
        )
}

proptest! {
    #![proptest_config(config())]

    /// A failed gate never reads as done, whatever state the row is in; a finished row with a failed gate reads failed.
    #[test]
    fn prop_failed_gate_never_reads_as_done(row in delegation()) {
        let got = derive_status(&row, GateVerdict::Failed);
        prop_assert_ne!(got.status, Status::Done);
        if row.state == COMPLETED {
            prop_assert_eq!(got.status, Status::Failed);
        }
    }

    /// An unsure verdict (the gates passed but the brief check was unsure, or a gate couldn't run) never reads as done or
    /// passed: a finished row waits as working for its first mate.
    #[test]
    fn prop_unsure_gate_never_reads_as_done(row in delegation()) {
        let got = derive_status(&row, GateVerdict::Unsure);
        prop_assert_ne!(got.status, Status::Done);
        if row.state == COMPLETED {
            prop_assert_eq!(got.status, Status::Working);
            prop_assert!(got.notice.is_some(), "an unsure row says what it waits for");
        }
    }

    /// A verdict still pending never reads as done: a finished row is working while its checks run.
    #[test]
    fn prop_pending_gate_never_reads_as_done(row in delegation()) {
        let got = derive_status(&row, GateVerdict::Pending);
        prop_assert_ne!(got.status, Status::Done);
        if row.state == COMPLETED {
            prop_assert_eq!(got.status, Status::Working);
        }
    }

    /// The converse: done comes from exactly one place, a finished row whose gates passed or do not apply.
    #[test]
    fn prop_done_only_from_a_finished_row_with_gates_passed_or_not_required(
        row in delegation(),
        gates in verdict(),
    ) {
        let got = derive_status(&row, gates);
        if got.status == Status::Done {
            prop_assert_eq!(row.state.as_str(), COMPLETED);
            prop_assert!(matches!(gates, GateVerdict::NotRequired | GateVerdict::Passed), "{:?}", gates);
        }
        // And the other way round: a finished row with passed or no gates is done.
        if row.state == COMPLETED && matches!(gates, GateVerdict::NotRequired | GateVerdict::Passed) {
            prop_assert_eq!(got.status, Status::Done);
        }
    }

    /// Only the exact stored word "passed" reads as passed. Any other text (a near miss, an unknown word, padding) is not
    /// yet passed, so a row carrying it is never done; a missing verdict means no gates apply.
    #[test]
    fn prop_a_stored_verdict_reads_as_passed_only_when_it_is_exactly_passed(stored in stored_word()) {
        let read = GateVerdict::stored(Some(&stored));
        prop_assert_eq!(read == GateVerdict::Passed, stored == GateVerdict::PASSED);
        if stored != GateVerdict::PASSED {
            prop_assert!(!is_done(COMPLETED, Some(&stored)), "{:?} read as done", stored);
        }
        // The known words keep their meaning.
        prop_assert_eq!(GateVerdict::stored(Some(GateVerdict::FAILED)), GateVerdict::Failed);
        prop_assert_eq!(GateVerdict::stored(Some(GateVerdict::UNSURE)), GateVerdict::Unsure);
    }

    /// The shortcut the clean-up asks (`is_done`) never says done for a row the full derivation would not.
    #[test]
    fn prop_is_done_agrees_with_the_derived_status(row in delegation()) {
        let derived = status_of(&row).status == Status::Done;
        prop_assert_eq!(is_done(&row.state, row.gate_verdict.as_deref()), derived);
        // A stored failed, unsure or pending verdict is never done.
        if matches!(row.gate_verdict.as_deref(), Some(w) if w != GateVerdict::PASSED) {
            prop_assert!(!derived);
        }
    }

    /// Derivation is pure, and a sent-back line from the log (untrusted text) never shows long or with control
    /// characters, and never shows when the verdict is not a failure.
    #[test]
    fn prop_notice_is_pure_and_a_sent_back_line_is_short_and_clean(
        row in delegation(),
        gates in verdict(),
    ) {
        let first = derive_status(&row, gates);
        prop_assert_eq!(&first, &derive_status(&row, gates));
        // Other states show the row's own error text, which is not a log line, so only the gate-driven states count.
        if row.state == RUNNING || row.state == COMPLETED {
            if let Some(notice) = first.notice.as_deref().filter(|n| n.starts_with("Sent back:")) {
                // An older send-back never outlives a later verdict.
                prop_assert_eq!(gates, GateVerdict::Failed);
                prop_assert!(sent_back_on(&row), "a shown send-back is one the log has");
                prop_assert!(notice.chars().count() <= 180, "{} characters", notice.chars().count());
                prop_assert!(!notice.chars().any(char::is_control));
            }
        }
    }
}
