//! Hivra WP-11's "Done when", Rust side: the wake queue says each thing once, drains into one turn, acknowledges through
//! the `seq` it saw, survives a restart (a real database file, closed and opened again), and timers fire once.

use std::path::PathBuf;

use super::queue::{self, WakeInput, PREFIX};
use super::timers::{self, TimerInput};
use super::*;
use crate::delegations::{delivery_step, ACKNOWLEDGED, DELIVERED, DISPOSED, PENDING, QUEUED};
use crate::session_store::SessionStore;

const MIN: i64 = 60_000;

fn store() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn stall(owner: &str, key: &str) -> WakeInput {
    WakeInput {
        owner_session: owner.into(),
        kind: "stall".into(),
        key: key.into(),
        delegation_id: None,
        generation: None,
        title: Some("Fix the save bug".into()),
        text: format!("Your worker has been quiet ({key})."),
    }
}

struct TempDb(PathBuf);

impl TempDb {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "hivra-wp11-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDb(dir.join("monocode.db"))
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[test]
fn the_ladder_is_the_delegations_one() {
    // Forward only, never out of disposed, nothing before it is ready, and re-queue only under a new message.
    assert!(delivery_step(PENDING, QUEUED, true, false));
    assert!(delivery_step(QUEUED, DELIVERED, true, false));
    assert!(delivery_step(DELIVERED, ACKNOWLEDGED, true, false));
    assert!(!delivery_step(ACKNOWLEDGED, DELIVERED, true, false));
    assert!(!delivery_step(DISPOSED, QUEUED, true, true));
    assert!(delivery_step(QUEUED, DISPOSED, false, false));
    assert!(!delivery_step(PENDING, QUEUED, false, false));
    assert!(!delivery_step(QUEUED, QUEUED, true, false));
    assert!(delivery_step(QUEUED, QUEUED, true, true));
}

#[test]
fn a_wake_is_said_once_per_owner_and_key() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let first = queue::add(&mut conn, stall("lead", "stall:d1:1:100"), 1_000).unwrap();
    assert!(first.fresh);
    assert_eq!(first.wake.seq, 1);
    assert_eq!(first.wake.delivery, PENDING);
    let again = queue::add(&mut conn, stall("lead", "stall:d1:1:100"), 2_000).unwrap();
    assert!(!again.fresh);
    assert_eq!(again.wake.id, first.wake.id);
    // A new stretch (new key) is a new wake; another owner has its own seq.
    let next = queue::add(&mut conn, stall("lead", "stall:d1:1:900"), 3_000).unwrap();
    assert!(next.fresh);
    assert_eq!(next.wake.seq, 2);
    let other = queue::add(&mut conn, stall("mono", "stall:d1:1:100"), 3_000).unwrap();
    assert_eq!(other.wake.seq, 1);
    assert_eq!(queue::open(&conn).unwrap().len(), 3);
}

#[test]
fn refuses_what_it_cant_say() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let bad_kind = WakeInput {
        kind: "report".into(),
        ..stall("lead", "k")
    };
    assert!(queue::add(&mut conn, bad_kind, 0).is_err());
    let no_text = WakeInput {
        text: "  ".into(),
        ..stall("lead", "k")
    };
    assert!(queue::add(&mut conn, no_text, 0).is_err());
    let bad_owner = stall("lead; DROP TABLE", "k");
    assert!(queue::add(&mut conn, bad_owner, 0).is_err());
    assert!(queue::add(&mut conn, stall("lead", ""), 0).is_err());
}

#[test]
fn drains_into_one_turn_and_acknowledges_through_what_it_saw() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    queue::add(&mut conn, stall("lead", "a"), 1).unwrap();
    queue::add(&mut conn, stall("lead", "b"), 2).unwrap();
    let drained = queue::drain(&mut conn, "lead", 10).unwrap().unwrap();
    assert_eq!(drained.through, 2);
    assert_eq!(drained.message_id, "fm-wake-lead-2");
    assert_eq!(drained.wakes.len(), 2);
    assert!(drained.text.starts_with(PREFIX));
    assert!(drained.text.contains("2 things need your judgment"));
    assert!(drained
        .wakes
        .iter()
        .all(|w| w.delivery == QUEUED && w.delivery_message.as_deref() == Some("fm-wake-lead-2")));
    assert_eq!(
        queue::parse_message_id(&drained.message_id),
        Some(("lead".into(), 2))
    );
    // Draining again before it goes out is the same turn.
    let again = queue::drain(&mut conn, "lead", 11).unwrap().unwrap();
    assert_eq!(again.message_id, drained.message_id);
    // A wake that arrives while the turn waits comes after it.
    queue::add(&mut conn, stall("lead", "c"), 12).unwrap();
    let moved = queue::delivered(&mut conn, &drained.message_id, 13).unwrap();
    assert_eq!(moved.len(), 2);
    assert!(moved.iter().all(|w| w.delivery == ACKNOWLEDGED));
    let next = queue::drain(&mut conn, "lead", 14).unwrap().unwrap();
    assert_eq!(next.through, 3);
    assert_eq!(next.wakes.len(), 1);
    assert!(next.text.contains("One thing needs your judgment"));
    // Acknowledging twice changes nothing.
    assert!(queue::ack(&mut conn, "lead", 2, 15).unwrap().is_empty());
    // Nothing owed: no turn.
    queue::ack(&mut conn, "lead", 3, 16).unwrap();
    assert!(queue::drain(&mut conn, "lead", 17).unwrap().is_none());
}

#[test]
fn a_removed_turn_is_disposed_and_never_comes_back() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    queue::add(&mut conn, stall("lead", "a"), 1).unwrap();
    let drained = queue::drain(&mut conn, "lead", 2).unwrap().unwrap();
    let gone = queue::set_delivery(&mut conn, &drained.message_id, DISPOSED, 3).unwrap();
    assert_eq!(gone.len(), 1);
    assert!(queue::drain(&mut conn, "lead", 4).unwrap().is_none());
    assert!(queue::set_delivery(&mut conn, &drained.message_id, QUEUED, 5).is_err());
    // Its key stays said.
    assert!(!queue::add(&mut conn, stall("lead", "a"), 6).unwrap().fresh);
}

#[test]
fn an_owner_that_is_gone_owes_nothing() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    queue::add(&mut conn, stall("lead", "a"), 1).unwrap();
    queue::add(&mut conn, stall("lead", "b"), 1).unwrap();
    assert_eq!(queue::dispose_owner(&mut conn, "lead", 2).unwrap(), 2);
    assert!(queue::open(&conn).unwrap().is_empty());
}

#[test]
fn the_queue_survives_a_restart() {
    let db = TempDb::new("restart");
    let drained_id;
    {
        // Before the crash: two wakes, one drained into a turn that never went out.
        let store = SessionStore::open(db.0.clone()).unwrap();
        let mut conn = store.lock_conn().unwrap();
        queue::add(&mut conn, stall("lead", "a"), 1).unwrap();
        drained_id = queue::drain(&mut conn, "lead", 2)
            .unwrap()
            .unwrap()
            .message_id;
        queue::add(&mut conn, stall("lead", "b"), 3).unwrap();
        timers::set(
            &mut conn,
            TimerInput {
                owner_session: "lead".into(),
                due_at: 10 * MIN,
                note: "look at the deploy".into(),
            },
            0,
        )
        .unwrap();
    }
    // The app comes back: the records are the truth.
    let store = SessionStore::open(db.0.clone()).unwrap();
    let mut conn = store.lock_conn().unwrap();
    let open = queue::open(&conn).unwrap();
    assert_eq!(open.len(), 2);
    assert_eq!(open[0].delivery, QUEUED);
    assert_eq!(
        open[0].delivery_message.as_deref(),
        Some(drained_id.as_str())
    );
    assert_eq!(open[1].delivery, PENDING);
    // The same thing said again after the restart is still one wake.
    assert!(!queue::add(&mut conn, stall("lead", "a"), 4).unwrap().fresh);
    // The next drain carries both, under the newest seq; the earlier message is replaced, not doubled.
    let drained = queue::drain(&mut conn, "lead", 5).unwrap().unwrap();
    assert_eq!(drained.wakes.len(), 2);
    assert_eq!(drained.through, 2);
    // The timer set before the restart fires once it is due, and only once.
    let tick1 = tick(&mut conn, 11 * MIN).unwrap();
    assert_eq!(tick1.fired.len(), 1);
    assert!(tick1.fired[0].text.contains("look at the deploy"));
    assert!(tick(&mut conn, 12 * MIN).unwrap().fired.is_empty());
}

#[test]
fn timers_are_bounded_owned_and_fire_once() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let input = |due_at: i64, note: &str| TimerInput {
        owner_session: "lead".into(),
        due_at,
        note: note.into(),
    };
    assert!(timers::set(&mut conn, input(30_000, "soon"), 0).is_err());
    assert!(timers::set(&mut conn, input(31 * 24 * 60 * MIN, "far"), 0).is_err());
    assert!(timers::set(&mut conn, input(5 * MIN, " "), 0).is_err());
    let timer = timers::set(&mut conn, input(5 * MIN, "check CI"), 0).unwrap();
    let other = timers::set(&mut conn, input(6 * MIN, "check the merge"), 0).unwrap();
    assert_eq!(timers::armed(&conn, "lead").unwrap().len(), 2);
    // Another chat can't cancel it.
    assert!(timers::cancel(&mut conn, "mono", &timer.id, 1)
        .unwrap()
        .is_none());
    assert!(timers::cancel(&mut conn, "lead", &other.id, 1)
        .unwrap()
        .is_some());
    assert!(tick(&mut conn, 4 * MIN).unwrap().fired.is_empty());
    let fired = tick(&mut conn, 30 * MIN).unwrap().fired;
    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0].kind, "timer");
    assert!(fired[0].text.contains("check CI"));
    assert!(fired[0].text.contains("due 25 minutes ago"));
    assert!(timers::armed(&conn, "lead").unwrap().is_empty());
    for n in 0..timers::ARMED_MAX {
        timers::set(&mut conn, input(40 * MIN + n as i64, "n"), 31 * MIN).unwrap();
    }
    assert!(timers::set(&mut conn, input(50 * MIN, "one too many"), 31 * MIN).is_err());
}

#[test]
fn settled_rows_are_pruned_a_month_on() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    queue::add(&mut conn, stall("lead", "a"), 0).unwrap();
    queue::add(&mut conn, stall("lead", "b"), 0).unwrap();
    let drained = queue::drain(&mut conn, "lead", 0).unwrap().unwrap();
    queue::ack(&mut conn, "lead", 1, 0).unwrap();
    assert_eq!(drained.through, 2);
    let pruned = tick(&mut conn, queue::KEEP_SETTLED + 1).unwrap().pruned;
    assert_eq!(pruned, 1);
    // The one still owed stays.
    assert_eq!(queue::open(&conn).unwrap().len(), 1);
}

#[test]
fn a_notice_about_a_worker_that_moved_on_is_dropped_not_delivered_late() {
    use crate::delegations::{record, settle, RecordInput, SettleInput, CANCELLED};
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let running = record(
        &mut conn,
        RecordInput {
            owner_session: "lead".into(),
            request_id: "r1".into(),
            child_session: "w1".into(),
            title: Some("Fix the save bug".into()),
            ..Default::default()
        },
        0,
    )
    .unwrap();
    let stopped = record(
        &mut conn,
        RecordInput {
            owner_session: "lead".into(),
            request_id: "r2".into(),
            child_session: "w2".into(),
            ..Default::default()
        },
        0,
    )
    .unwrap();
    let about = |row: &crate::delegations::Delegation, key: &str| WakeInput {
        delegation_id: Some(row.id.clone()),
        generation: Some(row.generation),
        ..stall("lead", key)
    };
    queue::add(&mut conn, about(&running, "still"), 1).unwrap();
    queue::add(&mut conn, about(&stopped, "gone"), 1).unwrap();
    queue::add(&mut conn, about(&running, "old-turn"), 1).unwrap();
    conn.execute(
        "UPDATE firstmate_wakes SET generation = 0 WHERE key = 'old-turn'",
        [],
    )
    .unwrap();
    settle(
        &mut conn,
        SettleInput {
            id: stopped.id.clone(),
            generation: stopped.generation,
            state: CANCELLED.into(),
            ..Default::default()
        },
        2,
    )
    .unwrap();
    let drained = queue::drain(&mut conn, "lead", 3).unwrap().unwrap();
    assert_eq!(
        drained
            .wakes
            .iter()
            .map(|w| w.key.as_str())
            .collect::<Vec<_>>(),
        ["still"]
    );
    // The two that moved on are disposed for good.
    assert!(queue::open(&conn).unwrap().iter().all(|w| w.key == "still"));
}
