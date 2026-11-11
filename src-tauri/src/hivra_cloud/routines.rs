//! Safety rules for routines that run on a Hivra Cloud machine (WP-61, from OpenBot's routine rules):
//! a 15-minute floor, a daily cap, stop after repeated failures (the person resumes), and skip missed windows
//! rather than catching up in a burst. Also the away feed: what ran while the person was away, filtered by what
//! started it. Pure functions; the machine scheduler and WP-60's run records call them.

use serde::{Deserialize, Serialize};

pub const MIN_INTERVAL_SECS: u64 = 15 * 60;
pub const FAILURES_BEFORE_STOP: u32 = 3;
pub const MAX_RUNS_PER_DAY: u32 = 24;
const DAY_SECS: u64 = 86_400;

#[derive(Debug, Clone, PartialEq)]
pub struct Routine {
    pub enabled: bool,
    pub interval_secs: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RoutineState {
    /// `None` means due at once.
    pub next_due: Option<u64>,
    pub failures: u32,
    pub stopped: bool,
    pub day: u64,
    pub runs_today: u32,
}

#[derive(Debug, PartialEq)]
pub enum Skip {
    Disabled,
    NotDue,
    MissedWindow,
    DailyCap,
    StoppedAfterFailures,
}

#[derive(Debug, PartialEq)]
pub enum Gate {
    Run,
    Skip(Skip),
}

pub fn effective_interval(secs: u64) -> u64 {
    secs.max(MIN_INTERVAL_SECS)
}

/// Decides whether a routine may run now. A `Run` counts against today's cap and sets the next due time.
pub fn gate(routine: &Routine, state: &mut RoutineState, now: u64) -> Gate {
    if !routine.enabled {
        return Gate::Skip(Skip::Disabled);
    }
    if state.stopped {
        return Gate::Skip(Skip::StoppedAfterFailures);
    }
    let interval = effective_interval(routine.interval_secs);
    if let Some(due) = state.next_due {
        if now < due {
            return Gate::Skip(Skip::NotDue);
        }
        // A whole interval late (the laptop slept): skip that window and wait a full interval, no burst.
        if now >= due.saturating_add(interval) {
            state.next_due = Some(now.saturating_add(interval));
            return Gate::Skip(Skip::MissedWindow);
        }
    }
    let today = now / DAY_SECS;
    if state.day != today {
        state.day = today;
        state.runs_today = 0;
    }
    if state.runs_today >= MAX_RUNS_PER_DAY {
        return Gate::Skip(Skip::DailyCap);
    }
    state.runs_today += 1;
    state.next_due = Some(now.saturating_add(interval));
    Gate::Run
}

/// Records how a run ended. `stopped` is set after `FAILURES_BEFORE_STOP` failures in a row.
pub fn record_outcome(state: &mut RoutineState, ok: bool) {
    if ok {
        state.failures = 0;
    } else {
        state.failures = state.failures.saturating_add(1);
    }
    if state.failures >= FAILURES_BEFORE_STOP {
        state.stopped = true;
    }
}

/// The person turns a stopped routine back on.
pub fn resume(state: &mut RoutineState) {
    state.failures = 0;
    state.stopped = false;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Starter {
    Person,
    Schedule,
    FirstMate,
}

/// One run, stamped with what started it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub label: String,
    pub starter: Starter,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub ok: bool,
}

/// Runs that finished at or after `away_since`, newest first. An empty `starters` list keeps every starter.
/// Runs still going are not in the feed.
pub fn away_feed(records: &[RunRecord], away_since: u64, starters: &[Starter]) -> Vec<RunRecord> {
    let mut feed: Vec<RunRecord> = records
        .iter()
        .filter(|r| r.finished_at.is_some_and(|finished| finished >= away_since))
        .filter(|r| starters.is_empty() || starters.contains(&r.starter))
        .cloned()
        .collect();
    feed.sort_by(|a, b| {
        b.finished_at
            .cmp(&a.finished_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    feed
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3600;

    fn routine(interval_secs: u64) -> Routine {
        Routine {
            enabled: true,
            interval_secs,
        }
    }

    #[test]
    fn no_routine_runs_more_often_than_every_fifteen_minutes() {
        assert_eq!(effective_interval(60), MIN_INTERVAL_SECS);
        assert_eq!(effective_interval(HOUR), HOUR);
        let mut state = RoutineState::default();
        assert_eq!(gate(&routine(60), &mut state, 0), Gate::Run);
        // Asked again one minute later: the floor means it is not due yet.
        assert_eq!(gate(&routine(60), &mut state, 60), Gate::Skip(Skip::NotDue));
    }

    #[test]
    fn a_disabled_routine_never_runs() {
        let mut state = RoutineState::default();
        let off = Routine {
            enabled: false,
            interval_secs: HOUR,
        };
        assert_eq!(gate(&off, &mut state, 0), Gate::Skip(Skip::Disabled));
        assert_eq!(state, RoutineState::default(), "a skip changes nothing");
    }

    #[test]
    fn three_failures_in_a_row_stop_it_until_the_person_resumes() {
        let mut state = RoutineState::default();
        let r = routine(HOUR);
        let mut now = 0;
        for _ in 0..FAILURES_BEFORE_STOP {
            assert_eq!(gate(&r, &mut state, now), Gate::Run);
            record_outcome(&mut state, false);
            now += HOUR;
        }
        assert!(state.stopped);
        assert_eq!(
            gate(&r, &mut state, now),
            Gate::Skip(Skip::StoppedAfterFailures)
        );
        resume(&mut state);
        assert_eq!(gate(&r, &mut state, now), Gate::Run);
    }

    #[test]
    fn a_success_clears_the_failure_count() {
        let mut state = RoutineState::default();
        let r = routine(HOUR);
        gate(&r, &mut state, 0);
        record_outcome(&mut state, false);
        gate(&r, &mut state, HOUR);
        record_outcome(&mut state, true);
        assert_eq!(state.failures, 0);
        assert!(!state.stopped);
    }

    #[test]
    fn a_missed_window_is_skipped_not_caught_up() {
        let mut state = RoutineState {
            next_due: Some(HOUR),
            ..Default::default()
        };
        // The laptop slept for five hours. One skip, then the next run is a full interval away.
        assert_eq!(
            gate(&routine(HOUR), &mut state, 6 * HOUR),
            Gate::Skip(Skip::MissedWindow)
        );
        assert_eq!(state.next_due, Some(7 * HOUR));
        assert_eq!(
            gate(&routine(HOUR), &mut state, 6 * HOUR + 1),
            Gate::Skip(Skip::NotDue)
        );
    }

    #[test]
    fn a_daily_cap_holds_until_the_next_day() {
        let r = routine(MIN_INTERVAL_SECS);
        let mut state = RoutineState::default();
        let mut now = 0;
        for _ in 0..MAX_RUNS_PER_DAY {
            assert_eq!(gate(&r, &mut state, now), Gate::Run);
            record_outcome(&mut state, true);
            now += MIN_INTERVAL_SECS;
        }
        assert_eq!(gate(&r, &mut state, now), Gate::Skip(Skip::DailyCap));
        // The next day's first window is skipped as missed (the cap held it), then the day's count starts again.
        assert_eq!(
            gate(&r, &mut state, DAY_SECS),
            Gate::Skip(Skip::MissedWindow)
        );
        assert_eq!(
            gate(&r, &mut state, DAY_SECS + MIN_INTERVAL_SECS),
            Gate::Run
        );
    }

    fn run(id: &str, starter: Starter, started: u64, finished: Option<u64>) -> RunRecord {
        RunRecord {
            id: id.into(),
            label: format!("run {id}"),
            starter,
            started_at: started,
            finished_at: finished,
            ok: true,
        }
    }

    #[test]
    fn the_away_feed_lists_what_finished_while_away_newest_first() {
        let records = vec![
            run("a", Starter::Schedule, 100, Some(150)),
            run("b", Starter::Person, 300, Some(400)),
            run("c", Starter::FirstMate, 200, Some(350)),
            run("old", Starter::Person, 10, Some(20)),
        ];
        let ids: Vec<String> = away_feed(&records, 100, &[])
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[test]
    fn the_away_feed_filters_by_what_started_each_run() {
        let records = vec![
            run("a", Starter::Schedule, 100, Some(150)),
            run("b", Starter::Person, 300, Some(400)),
            run("c", Starter::FirstMate, 200, Some(350)),
        ];
        let ids: Vec<String> = away_feed(&records, 0, &[Starter::FirstMate, Starter::Schedule])
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["c", "a"]);
    }

    #[test]
    fn runs_still_going_are_not_in_the_feed() {
        let records = vec![run("open", Starter::Person, 100, None)];
        assert!(away_feed(&records, 0, &[]).is_empty());
    }
}
