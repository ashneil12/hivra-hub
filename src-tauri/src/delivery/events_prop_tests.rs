//! SC-6 (spec 4i): property tests for the delivery event transitions.
//!
//! The rules that must always hold: a red CI gets one fix round at most, and merged and closed are final. A reference
//! model, a tiny enum written from the table in the module header, is driven in step with the real `record` against an
//! in-memory database (`proptest-state-machine`); the state the row ends in must match the model after every event.
//! The pure `next` is also checked over states and round counts the model never reaches (a row from disk, an unknown
//! state, a negative count).

use proptest::prelude::*;
use proptest_state_machine::{prop_state_machine, ReferenceStateMachine, StateMachineTest};

use super::{next, open, record, Kind, News};
use crate::delivery::deliver::{self, CHECKING, CLOSED, FAILED, FIXING, MERGED, READY};
use crate::session_store::SessionStore;

/// 64 cases a run, or whatever `PROPTEST_CASES` says (an explicit `cases` would override the variable).
fn config() -> ProptestConfig {
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 64;
    }
    config
}

fn kind() -> impl Strategy<Value = Kind> {
    prop_oneof![
        Just(Kind::CiRed),
        Just(Kind::CiGreen),
        Just(Kind::Merged),
        Just(Kind::Closed)
    ]
}

// ---- the reference model --------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Checking,
    Fixing,
    Ready,
    Failed,
    Merged,
    Closed,
}

impl Phase {
    fn word(self) -> &'static str {
        match self {
            Phase::Checking => CHECKING,
            Phase::Fixing => FIXING,
            Phase::Ready => READY,
            Phase::Failed => FAILED,
            Phase::Merged => MERGED,
            Phase::Closed => CLOSED,
        }
    }
}

/// What a delivery of a pull request is, as far as the events move it.
#[derive(Clone, Debug)]
struct Model {
    phase: Phase,
    fix_rounds: i64,
    /// Opened by the local check: a red result is repaired by that check, not by a fix round (WP-81).
    through_gate: bool,
}

#[derive(Clone, Debug)]
enum Step {
    /// CI news, or the pull request merging or closing.
    News(Kind),
    /// The pull request is now known to come from the local check.
    LocalCheck,
}

struct Machine;

impl ReferenceStateMachine for Machine {
    type State = Model;
    type Transition = Step;

    fn init_state() -> BoxedStrategy<Model> {
        let start = |phase, fix_rounds| Model {
            phase,
            fix_rounds,
            through_gate: false,
        };
        prop_oneof![
            // A checked pull request, as it opens.
            6 => Just(start(Phase::Checking, 0)),
            // A plain pull request, ready when it opens.
            2 => Just(start(Phase::Ready, 0)),
            // Rows already part-way: a round already spent, whatever state a row from disk says.
            1 => Just(start(Phase::Checking, 1)),
            1 => Just(start(Phase::Fixing, 1)),
            1 => Just(start(Phase::Failed, 1)),
            1 => Just(start(Phase::Ready, 1)),
        ]
        .boxed()
    }

    fn transitions(_: &Model) -> BoxedStrategy<Step> {
        prop_oneof![
            4 => Just(Step::News(Kind::CiRed)),
            3 => Just(Step::News(Kind::CiGreen)),
            1 => Just(Step::News(Kind::Merged)),
            1 => Just(Step::News(Kind::Closed)),
            1 => Just(Step::LocalCheck),
        ]
        .boxed()
    }

    fn apply(mut model: Model, step: &Step) -> Model {
        let kind = match step {
            Step::LocalCheck => {
                model.through_gate = true;
                return model;
            }
            Step::News(kind) => *kind,
        };
        // Merged and closed are final: nothing leaves them.
        if matches!(model.phase, Phase::Merged | Phase::Closed) {
            return model;
        }
        match kind {
            Kind::Merged => model.phase = Phase::Merged,
            Kind::Closed => model.phase = Phase::Closed,
            Kind::CiGreen => {
                if matches!(model.phase, Phase::Checking | Phase::Fixing) {
                    model.phase = Phase::Ready;
                }
            }
            Kind::CiRed => {
                if model.through_gate {
                    return model;
                }
                match model.phase {
                    // The one fix round: red while checking, with no round spent yet.
                    Phase::Checking if model.fix_rounds == 0 => {
                        model.phase = Phase::Fixing;
                        model.fix_rounds = 1;
                    }
                    // Red again, or red with the round already spent: the first mate decides.
                    Phase::Checking | Phase::Fixing => model.phase = Phase::Failed,
                    Phase::Ready | Phase::Failed | Phase::Merged | Phase::Closed => {}
                }
            }
        }
        model
    }
}

// ---- the system under test: the real events against a real (in-memory) database -------------------------------------

struct Sut {
    store: SessionStore,
    id: String,
    clock: i64,
    /// Events handed to `record`, each of which must be kept for the classifier.
    recorded: usize,
    /// How many times the row went from checking to fixing: a fix round begun.
    rounds_begun: u32,
}

struct DeliveryEvents;

impl StateMachineTest for DeliveryEvents {
    type SystemUnderTest = Sut;
    type Reference = Machine;

    fn init_test(model: &Model) -> Sut {
        let store = SessionStore::open_in_memory().unwrap();
        store
            .lock_conn()
            .unwrap()
            .execute(
                "INSERT INTO work_deliveries (id, delegation_id, project, checkout, mode, state, repo, number, url, branch, fix_rounds, detail, created_at, updated_at)
                 VALUES ('dlv-1', NULL, '/project', NULL, 'checked-pr', ?1, 'acme/web', 7, NULL, 'work', ?2, NULL, 1, 1)",
                rusqlite::params![model.phase.word(), model.fix_rounds],
            )
            .unwrap();
        Sut {
            store,
            id: "dlv-1".into(),
            clock: 10,
            recorded: 0,
            rounds_begun: 0,
        }
    }

    fn apply(mut sut: Sut, _model: &Model, step: Step) -> Sut {
        sut.clock += 1;
        let conn = sut.store.lock_conn().unwrap();
        let before = deliver::get(&conn, &sut.id).unwrap().unwrap();
        let changed = match &step {
            Step::LocalCheck => {
                deliver::mark_gate(&conn, &sut.id).unwrap();
                Vec::new()
            }
            Step::News(kind) => {
                sut.recorded += 1;
                record(
                    &conn,
                    "acme/web",
                    7,
                    Some(&format!("{:040x}", sut.clock)),
                    &[News {
                        kind: *kind,
                        detail: Some("build".into()),
                    }],
                    sut.clock,
                )
                .unwrap()
            }
        };
        let after = deliver::get(&conn, &sut.id).unwrap().unwrap();
        // Merged and closed are final: no event moves the row out, or touches its rounds.
        if before.state == MERGED || before.state == CLOSED {
            assert_eq!(
                (&after.state, after.fix_rounds),
                (&before.state, before.fix_rounds),
                "{step:?} moved a settled delivery"
            );
        }
        // A fix round is only ever begun by red while checking with none spent; no other move touches the count.
        if after.fix_rounds != before.fix_rounds {
            assert_eq!(
                (
                    before.state.as_str(),
                    before.fix_rounds,
                    after.state.as_str(),
                    after.fix_rounds
                ),
                (CHECKING, 0, FIXING, 1),
                "{step:?} changed the fix rounds"
            );
            sut.rounds_begun += 1;
        }
        // The row's own report of a move agrees with what happened to it.
        let moved = before.state != after.state || before.fix_rounds != after.fix_rounds;
        assert_eq!(
            changed.contains(&sut.id),
            moved,
            "{step:?}: reported {changed:?}, row went {before:?} to {after:?}"
        );
        drop(conn);
        sut
    }

    fn check_invariants(sut: &Sut, model: &Model) {
        let conn = sut.store.lock_conn().unwrap();
        let row = deliver::get(&conn, &sut.id).unwrap().unwrap();
        // The row is where the model says, after every event.
        assert_eq!(row.state, model.phase.word());
        assert_eq!(row.fix_rounds, model.fix_rounds);
        // At most one fix round is ever begun, whatever the events.
        assert!(
            sut.rounds_begun <= 1,
            "{} fix rounds begun",
            sut.rounds_begun
        );
        // Every event is kept for the classifier, including the ones that moved nothing.
        assert_eq!(open(&conn).unwrap().len(), sut.recorded);
    }
}

prop_state_machine! {
    #![proptest_config(config())]

    /// Red CI gets one fix round at most, and merged and closed are final, over any run of CI news, merges, closes and
    /// the local check taking a pull request over.
    #[test]
    fn prop_delivery_events_give_one_fix_round_and_merged_and_closed_are_final(sequential 1..40 => DeliveryEvents);
}

proptest! {
    #![proptest_config(config())]

    /// `next` over states and round counts the model never reaches: an unknown state, a count that is negative or huge.
    /// Merged and closed never move; a fix round only starts from checking with none spent; no other move changes the
    /// count; and an unknown state only ever settles.
    #[test]
    fn prop_next_never_moves_a_settled_delivery_or_grants_a_second_fix_round(
        state in prop_oneof![
            Just(CHECKING.to_string()),
            Just(FIXING.to_string()),
            Just(READY.to_string()),
            Just(FAILED.to_string()),
            Just(MERGED.to_string()),
            Just(CLOSED.to_string()),
            Just(deliver::LANDED.to_string()),
            Just(deliver::CONFLICT.to_string()),
            any::<String>(),
        ],
        rounds in prop_oneof![3 => -1i64..4, 1 => any::<i64>()],
        kind in kind(),
    ) {
        let got = next(&state, rounds, kind);
        if state == MERGED || state == CLOSED {
            prop_assert_eq!(got, None, "a settled delivery moved on {:?}", kind);
        }
        if let Some((to, new_rounds)) = got {
            if to == FIXING {
                prop_assert_eq!((state.as_str(), rounds, kind), (CHECKING, 0, Kind::CiRed));
            }
            if new_rounds != rounds {
                prop_assert_eq!((state.as_str(), rounds, kind, to, new_rounds), (CHECKING, 0, Kind::CiRed, FIXING, 1));
            }
            // Red never leads anywhere but a first fix round or failure.
            if kind == Kind::CiRed {
                prop_assert!(to == FIXING || to == FAILED, "red moved to {}", to);
                prop_assert!(state == CHECKING || state == FIXING);
            }
            // Only the four known open states can become ready; an unknown state only settles.
            if to == READY {
                prop_assert!(kind == Kind::CiGreen && (state == CHECKING || state == FIXING));
            }
            if ![CHECKING, FIXING, READY, FAILED, MERGED, CLOSED].contains(&state.as_str()) {
                prop_assert!(matches!(kind, Kind::Merged | Kind::Closed), "an unknown state moved on {:?}", kind);
            }
        }
    }
}
