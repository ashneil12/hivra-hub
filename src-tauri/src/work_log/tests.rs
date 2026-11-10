use std::path::PathBuf;

use rusqlite::Connection;
use time::{Date, Month, OffsetDateTime, Time};

use super::*;
use crate::portable::scrubber;
use crate::session_store::SessionStore;

const GITHUB: &str = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";
const PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAPLANTED\n-----END OPENSSH PRIVATE KEY-----";
const ASSIGNED: &str = "password = Planted9Secret9Value9X";

fn memory() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn unix_ms(year: i32, month: u8, day: u8) -> i64 {
    let date = Date::from_calendar_date(year, Month::try_from(month).unwrap(), day).unwrap();
    OffsetDateTime::new_utc(date, Time::MIDNIGHT).unix_timestamp() * 1000
}

fn add(
    conn: &Connection,
    kind: &str,
    project: &str,
    task_id: &str,
    line: &str,
    at_ms: i64,
    source: &str,
) -> Line {
    append(
        conn,
        &NewLine {
            project,
            kind,
            task_id,
            line,
            at_ms,
            offset_seconds: Some(0),
            source,
        },
    )
    .unwrap()
}

struct TempDb {
    root: PathBuf,
    db: PathBuf,
}

impl TempDb {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hivra-work-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Self {
            db: root.join("log.sqlite"),
            root,
        }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let Ok(root) = crate::fs::canonical(&self.root) else {
            return;
        };
        let Ok(tmp) = crate::fs::canonical(std::env::temp_dir()) else {
            return;
        };
        if root.starts_with(&tmp) && root != tmp {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

#[test]
fn the_table_arrives_with_the_schema_and_a_row_cannot_be_changed() {
    assert_eq!(LINE_CAP, 2_000);
    let store = memory();
    let conn = store.lock_conn().unwrap();
    ensure_tables(&conn).unwrap();
    let row = add(
        &conn,
        "outcome",
        "tally",
        "task-1",
        "Shipped the work log.",
        unix_ms(2026, 11, 10),
        "delegation:task-1:done",
    );
    let update = conn
        .execute(
            "UPDATE work_log SET line = 'rewritten' WHERE seq = ?1",
            [row.seq],
        )
        .unwrap_err()
        .to_string();
    assert!(update.contains("append-only"), "{update}");
    let delete = conn
        .execute("DELETE FROM work_log WHERE seq = ?1", [row.seq])
        .unwrap_err()
        .to_string();
    assert!(delete.contains("append-only"), "{delete}");
    let kept = list(&conn, &ReadQuery::default()).unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].line, "Shipped the work log.");
    assert_eq!(kept[0].day, "2026-11-10");
    assert_eq!(kept[0].created_at, unix_ms(2026, 11, 10));

    let bad = conn
        .execute(
            "INSERT INTO work_log (project, day, kind, task_id, line, created_at, source)
             VALUES ('', '2026-11-10', 'note', '', 'no', 0, '')",
            [],
        )
        .unwrap_err()
        .to_string();
    assert!(bad.contains("CHECK") || bad.contains("constraint"), "{bad}");
}

#[test]
fn kinds_are_only_the_four_and_a_blank_line_is_refused() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    for kind in ["outcome", "decision", "feedback", "context"] {
        let row = add(&conn, kind, "", "", &format!("A {kind} line."), 0, "");
        assert_eq!(row.kind, kind);
    }
    for kind in ["", "outcome ", "OUTCOME", "note", "outcome/extra"] {
        let err = append(
            &conn,
            &NewLine {
                project: "",
                kind,
                task_id: "",
                line: "Words.",
                at_ms: 0,
                offset_seconds: Some(0),
                source: "",
            },
        )
        .unwrap_err();
        assert!(err.contains("outcome"), "{kind}: {err}");
    }
    for line in ["", "   ", "\r\n\t", "\0"] {
        let err = append(
            &conn,
            &NewLine {
                project: "",
                kind: "feedback",
                task_id: "",
                line,
                at_ms: 0,
                offset_seconds: Some(0),
                source: "",
            },
        )
        .unwrap_err();
        assert!(err.contains("needs words"), "{line:?}: {err}");
    }
    let folded = add(
        &conn,
        "context",
        "My\r\nProject",
        "",
        "Done.\r\nNext.\tStep.",
        0,
        "",
    );
    assert_eq!(folded.project, "My Project");
    assert_eq!(folded.line, "Done. Next. Step.");
    assert!(!folded.line.contains('\n') && !folded.line.contains('\r'));
    let joined = add(&conn, "context", "", "", "Ship\0ped", 0, "");
    assert_eq!(joined.line, "Shipped");
    assert!(!joined.line.contains('\0'));
}

#[test]
fn secrets_are_scrubbed_before_the_line_is_cut() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let row = add(
        &conn,
        "outcome",
        GITHUB,
        ASSIGNED,
        &format!("Shipped with {GITHUB} in the note. {PRIVATE_KEY} {ASSIGNED}"),
        0,
        "",
    );
    assert!(!row.line.contains("ghp_"), "{}", row.line);
    assert!(!row.line.contains("BEGIN OPENSSH"), "{}", row.line);
    assert!(!row.line.contains("Planted9Secret9Value9X"), "{}", row.line);
    assert!(!scrubber().has_secret(&row.line), "{}", row.line);
    assert!(row.line.contains("[secret removed]"), "{}", row.line);
    assert!(!row.project.contains("ghp_"), "{}", row.project);
    assert!(!scrubber().has_secret(&row.project), "{}", row.project);
    assert!(
        !row.task_id.contains("Planted9Secret9Value9X"),
        "{}",
        row.task_id
    );
    assert!(!scrubber().has_secret(&row.task_id), "{}", row.task_id);

    let prefix = "a".repeat(1_990);
    let near_the_cut = add(
        &conn,
        "outcome",
        "",
        "",
        &format!("{prefix} {GITHUB} and then more words"),
        0,
        "",
    );
    assert!(near_the_cut.line.chars().count() <= LINE_CAP);
    assert!(!near_the_cut.line.contains("ghp_"), "{}", near_the_cut.line);
    assert!(
        !near_the_cut.line.contains("[secret"),
        "{}",
        near_the_cut.line
    );
    assert!(near_the_cut.line.starts_with(&prefix));
    assert!(!scrubber().has_secret(&near_the_cut.line));
}

#[test]
fn the_line_cap_counts_characters_and_does_not_split_one() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let exact = "é".repeat(LINE_CAP);
    let kept = add(&conn, "outcome", "", "", &exact, 0, "");
    assert_eq!(kept.line, exact);

    let long = format!("{}b", "a".repeat(LINE_CAP));
    let cut = add(&conn, "outcome", "", "", &long, 0, "");
    assert_eq!(cut.line.chars().count(), LINE_CAP);
    assert!(cut.line.chars().all(|ch| ch == 'a'));

    let boundary = format!("{}你b", "a".repeat(LINE_CAP - 1));
    let whole = add(&conn, "outcome", "", "", &boundary, 0, "");
    assert_eq!(whole.line.chars().count(), LINE_CAP);
    assert!(whole.line.ends_with('你'));
    assert!(!whole.line.contains('b'));

    let dropped = format!("{}b你", "a".repeat(LINE_CAP - 1));
    let without = add(&conn, "outcome", "", "", &dropped, 0, "");
    assert_eq!(without.line.chars().count(), LINE_CAP);
    assert!(without.line.ends_with('b'));
    assert!(!without.line.contains('你'));

    let project = format!("計{}", "画".repeat(FIELD_CAP));
    let stored = add(
        &conn,
        "context",
        &project,
        &"x".repeat(FIELD_CAP + 50),
        "Noted.",
        0,
        "",
    );
    assert_eq!(stored.project.chars().count(), FIELD_CAP);
    assert!(stored.project.starts_with('計'));
    assert_eq!(stored.task_id.chars().count(), FIELD_CAP);
    assert!(stored.task_id.chars().all(|ch| ch == 'x'));
}

#[test]
fn the_local_day_follows_the_offset_including_midnight_and_leap_days() {
    let midnight = unix_ms(2026, 1, 1);
    assert_eq!(civil_day(midnight, 0).unwrap(), "2026-01-01");
    assert_eq!(civil_day(midnight - 1, 0).unwrap(), "2025-12-31");
    assert_eq!(civil_day(midnight - 1, 1).unwrap(), "2026-01-01");
    assert_eq!(civil_day(midnight, -1).unwrap(), "2025-12-31");
    assert_eq!(civil_day(midnight, -18 * 3600).unwrap(), "2025-12-31");
    assert_eq!(civil_day(midnight, 18 * 3600).unwrap(), "2026-01-01");
    // Wider than any real zone. Treated as UTC, not as a made-up day.
    assert_eq!(civil_day(midnight, 19 * 3600).unwrap(), "2026-01-01");
    assert_eq!(civil_day(midnight, -19 * 3600).unwrap(), "2026-01-01");

    let before = unix_ms(2026, 1, 1) - 5 * 3600 * 1000 - 30 * 60 * 1000;
    assert_eq!(civil_day(before, 5 * 3600 + 30 * 60).unwrap(), "2026-01-01");
    assert_eq!(
        civil_day(before, 5 * 3600 + 30 * 60 - 1).unwrap(),
        "2025-12-31"
    );
    let nepal = unix_ms(2026, 1, 1) - (5 * 3600 + 45 * 60) * 1000;
    assert_eq!(civil_day(nepal, 5 * 3600 + 45 * 60).unwrap(), "2026-01-01");
    assert_eq!(
        civil_day(nepal, 5 * 3600 + 45 * 60 - 1).unwrap(),
        "2025-12-31"
    );

    let leap = unix_ms(2024, 2, 29);
    assert_eq!(civil_day(leap, 0).unwrap(), "2024-02-29");
    assert_eq!(civil_day(leap - 1000, 0).unwrap(), "2024-02-28");
    let nineteen = unix_ms(1900, 3, 1);
    assert_eq!(civil_day(nineteen - 1000, 0).unwrap(), "1900-02-28");
    let two_thousand = unix_ms(2000, 3, 1);
    assert_eq!(civil_day(two_thousand - 1000, 0).unwrap(), "2000-02-29");

    assert!(civil_day(i64::MAX, 0).is_err());
    assert!(civil_day(i64::MIN, 0).is_err());

    let store = memory();
    let conn = store.lock_conn().unwrap();
    let row = append(
        &conn,
        &NewLine {
            project: "tally",
            kind: "outcome",
            task_id: "",
            line: "Finished just before midnight at home.",
            at_ms: midnight,
            offset_seconds: Some(-8 * 3600),
            source: "",
        },
    )
    .unwrap();
    assert_eq!(row.day, "2025-12-31");
    assert_eq!(row.created_at, midnight);
}

#[test]
fn a_repeated_source_returns_the_first_line_and_a_hand_line_can_repeat() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let first = add(
        &conn,
        "outcome",
        "tally",
        "task-1",
        "Shipped the panel.",
        unix_ms(2026, 11, 10),
        "delegation:task-1:done",
    );
    let again = append(
        &conn,
        &NewLine {
            project: "other",
            kind: "outcome",
            task_id: "task-1",
            line: "A different ending.",
            at_ms: unix_ms(2026, 11, 11),
            offset_seconds: Some(0),
            source: "delegation:task-1:done",
        },
    )
    .unwrap();
    assert_eq!(again, first);
    assert_eq!(list(&conn, &ReadQuery::default()).unwrap().len(), 1);

    let sent_back = add(
        &conn,
        "outcome",
        "tally",
        "task-1",
        "Sent back once.",
        unix_ms(2026, 11, 9),
        "delegation:task-1:sent-back:1",
    );
    assert_ne!(sent_back.seq, first.seq);

    let hand = add(&conn, "feedback", "", "", "Say it again.", 1, "");
    let hand_again = add(&conn, "feedback", "", "", "Say it again.", 2, "   ");
    assert_ne!(hand.seq, hand_again.seq);
    assert_eq!(list(&conn, &ReadQuery::default()).unwrap().len(), 4);

    let err = append(
        &conn,
        &NewLine {
            project: "",
            kind: "context",
            task_id: "",
            line: "Noted.",
            at_ms: 0,
            offset_seconds: Some(0),
            source: &"s".repeat(SOURCE_CAP + 1),
        },
    )
    .unwrap_err();
    assert!(err.contains("too long"), "{err}");
    let err = append(
        &conn,
        &NewLine {
            project: "",
            kind: "context",
            task_id: "",
            line: "Noted.",
            at_ms: 0,
            offset_seconds: Some(0),
            source: &format!("delegation:{GITHUB}"),
        },
    )
    .unwrap_err();
    assert!(err.contains("secret"), "{err}");
    assert!(!list(&conn, &ReadQuery::default())
        .unwrap()
        .iter()
        .any(|row| row.line == "Noted."));
}

#[test]
fn list_filters_by_project_day_and_kind_and_rejects_a_bad_day() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    add(
        &conn,
        "outcome",
        "tally",
        "a",
        "Tally shipped.",
        unix_ms(2026, 11, 9),
        "a",
    );
    add(
        &conn,
        "decision",
        "tally",
        "b",
        "Use the local day.",
        unix_ms(2026, 11, 10),
        "b",
    );
    add(
        &conn,
        "outcome",
        "other",
        "c",
        "Other shipped.",
        unix_ms(2026, 11, 10),
        "c",
    );
    add(
        &conn,
        "feedback",
        "計画",
        "",
        "A note.",
        unix_ms(2026, 11, 10) + 1,
        "d",
    );
    add(
        &conn,
        "context",
        "",
        "",
        "No project.",
        unix_ms(2026, 11, 8),
        "e",
    );
    add(
        &conn,
        "context",
        "..",
        "",
        "A project named dot dot.",
        unix_ms(2026, 11, 8),
        "f",
    );
    add(
        &conn,
        "context",
        "My Project",
        "",
        "Spaces stay.",
        unix_ms(2026, 11, 7),
        "g",
    );

    let tally = list(
        &conn,
        &ReadQuery {
            project: Some("tally".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert_eq!(tally.len(), 2);
    assert_eq!(tally[0].line, "Tally shipped.");
    assert_eq!(tally[1].line, "Use the local day.");

    let day = list(
        &conn,
        &ReadQuery {
            from_day: Some("2026-11-10".into()),
            to_day: Some("2026-11-10".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert_eq!(day.len(), 3);
    assert!(day.iter().all(|row| row.day == "2026-11-10"));

    let outcomes = list(
        &conn,
        &ReadQuery {
            kind: Some("outcome".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert_eq!(outcomes.len(), 2);

    let none = list(
        &conn,
        &ReadQuery {
            project: Some("%".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert!(none.is_empty());
    let dots = list(
        &conn,
        &ReadQuery {
            project: Some("..".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert_eq!(dots.len(), 1);
    assert_eq!(dots[0].line, "A project named dot dot.");
    let named = list(
        &conn,
        &ReadQuery {
            project: Some("計画".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert_eq!(named.len(), 1);
    let blank = list(
        &conn,
        &ReadQuery {
            project: Some(String::new()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert_eq!(blank.len(), 1);
    assert_eq!(blank[0].line, "No project.");
    let spaced = list(
        &conn,
        &ReadQuery {
            project: Some("My Project".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert_eq!(spaced[0].line, "Spaces stay.");

    let same_time_first = add(&conn, "outcome", "order", "", "First.", 50, "first");
    let same_time_second = add(&conn, "outcome", "order", "", "Second.", 50, "second");
    let ordered = list(
        &conn,
        &ReadQuery {
            project: Some("order".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap();
    assert_eq!(ordered[0].seq, same_time_first.seq);
    assert_eq!(ordered[1].seq, same_time_second.seq);

    for day in [
        "",
        "2026-02-31",
        "2025-02-29",
        "2026-1-01",
        "2026/11/10",
        "2026-11-10 ",
    ] {
        let err = list(
            &conn,
            &ReadQuery {
                from_day: Some(day.into()),
                ..ReadQuery::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("2026-11-10"), "{day}: {err}");
    }
    assert!(list(
        &conn,
        &ReadQuery {
            from_day: Some("2024-02-29".into()),
            to_day: Some("2024-02-29".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap()
    .is_empty());
    let backwards = list(
        &conn,
        &ReadQuery {
            from_day: Some("2026-11-10".into()),
            to_day: Some("2026-11-09".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap_err();
    assert!(backwards.contains("before"), "{backwards}");
    let bad_kind = list(
        &conn,
        &ReadQuery {
            kind: Some("note".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap_err();
    assert!(bad_kind.contains("outcome"), "{bad_kind}");
    assert!(list(&conn, &ReadQuery::default()).unwrap().len() >= 7);
}

#[test]
fn two_connections_keep_every_new_line_and_one_copy_of_a_repeated_source() {
    let temp = TempDb::new();
    {
        let store = SessionStore::open(temp.db.clone()).unwrap();
        drop(store);
    }
    std::thread::scope(|scope| {
        for index in 0..8 {
            let path = &temp.db;
            scope.spawn(move || {
                let conn = Connection::open(path).unwrap();
                append(
                    &conn,
                    &NewLine {
                        project: "tally",
                        kind: "outcome",
                        task_id: &format!("task-{index}"),
                        line: &format!("Finished {index}."),
                        at_ms: index,
                        offset_seconds: Some(0),
                        source: &format!("row-{index}"),
                    },
                )
                .unwrap();
            });
        }
    });
    std::thread::scope(|scope| {
        for index in 0..8 {
            let path = &temp.db;
            scope.spawn(move || {
                let conn = Connection::open(path).unwrap();
                let row = append(
                    &conn,
                    &NewLine {
                        project: "tally",
                        kind: "outcome",
                        task_id: "shared",
                        line: &format!("Attempt {index}."),
                        at_ms: 100 + index,
                        offset_seconds: Some(0),
                        source: "shared-source",
                    },
                )
                .unwrap();
                assert_eq!(row.source, "shared-source");
            });
        }
    });
    let conn = Connection::open(&temp.db).unwrap();
    let rows = list(&conn, &ReadQuery::default()).unwrap();
    assert_eq!(rows.len(), 9);
    assert_eq!(
        rows.iter()
            .filter(|row| row.source == "shared-source")
            .count(),
        1
    );
    let shared = rows
        .iter()
        .find(|row| row.source == "shared-source")
        .unwrap();
    assert!(shared.line.starts_with("Attempt "));
    for index in 0..8 {
        assert!(rows.iter().any(|row| row.source == format!("row-{index}")));
    }
}

#[cfg(unix)]
#[test]
fn the_machine_zone_matches_localtime_for_the_given_instant() {
    for secs in [1_767_225_600_i64, 1_782_864_000_i64] {
        let mut civil: libc::tm = unsafe { std::mem::zeroed() };
        let stamp = secs as libc::time_t;
        let ptr = unsafe { libc::localtime_r(&stamp, &mut civil) };
        assert!(!ptr.is_null());
        let offset = local_offset_seconds(secs);
        assert_eq!(offset, sane_offset(civil.tm_gmtoff));
        let day = civil_day(secs * 1000, offset).unwrap();
        let expect = format!(
            "{:04}-{:02}-{:02}",
            civil.tm_year + 1900,
            civil.tm_mon + 1,
            civil.tm_mday
        );
        assert_eq!(day, expect, "offset {offset} at {secs}");
    }
}

#[cfg(windows)]
#[test]
fn the_machine_zone_is_a_real_offset_for_the_given_instant() {
    for secs in [1_767_225_600_i64, 1_782_864_000_i64] {
        let offset = local_offset_seconds(secs);
        assert!((-18 * 3600..=18 * 3600).contains(&offset), "{offset}");
        assert!(civil_day(secs * 1000, offset).is_ok());
    }
}
