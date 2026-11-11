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

fn outcomes(conn: &Connection) -> Vec<Line> {
    list(
        conn,
        &ReadQuery {
            kind: Some("outcome".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap()
}

fn decisions(conn: &Connection) -> Vec<Line> {
    list(
        conn,
        &ReadQuery {
            kind: Some("decision".into()),
            ..ReadQuery::default()
        },
    )
    .unwrap()
}

fn activity_rows(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM activity", [], |row| row.get(0))
        .unwrap()
}

fn launch(request: &str, child: &str) -> crate::delegations::RecordInput {
    crate::delegations::RecordInput {
        owner_session: "lead".into(),
        request_id: request.into(),
        child_session: child.into(),
        project: Some("tally".into()),
        title: Some("Save the export".into()),
        brief: Some("Save the export as a file.".into()),
        ..Default::default()
    }
}

fn finish(id: &str, generation: i64, state: &str, result: &str) -> crate::delegations::SettleInput {
    crate::delegations::SettleInput {
        id: id.into(),
        generation,
        state: state.into(),
        result: Some(result.into()),
        ..Default::default()
    }
}

#[test]
fn the_time_from_queued_is_plain_words() {
    assert_eq!(span_words(0), "Under a minute from queued.");
    assert_eq!(span_words(59_999), "Under a minute from queued.");
    assert_eq!(span_words(60_000), "1 minute from queued.");
    assert_eq!(span_words(12 * 60_000), "12 minutes from queued.");
    assert_eq!(span_words(60 * 60_000), "1 hour from queued.");
    assert_eq!(span_words(90 * 60_000), "1 hour 30 minutes from queued.");
    assert_eq!(span_words(24 * 60 * 60_000), "1 day from queued.");
    assert_eq!(
        span_words(((24 + 4) * 60) * 60_000),
        "1 day 4 hours from queued."
    );
    assert_eq!(
        span_words(((26 * 60) + 1) * 60_000),
        "1 day 2 hours 1 minute from queued."
    );
    assert_eq!(rework_words(0), "No rework.");
    assert_eq!(rework_words(1), "Reworked once.");
    assert_eq!(rework_words(2), "Reworked 2 times.");
    assert_eq!(elapsed_ms(50, 10), 0);
    assert_eq!(elapsed_ms(i64::MIN, i64::MAX), 0);
}

#[test]
fn a_finished_task_writes_one_outcome_line() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let before = activity_rows(&conn);
    let queued = unix_ms(2026, 11, 10);
    let mut input = launch("req-1", "worker-1");
    input.title = Some("保存 the export".into());
    let row = crate::delegations::record(&mut conn, input, queued).unwrap();
    let at = queued + 90 * 60_000;
    let mut settled = finish(
        &row.id,
        1,
        crate::delegations::COMPLETED,
        "Wrote the file.\r\nIt loads.",
    );
    settled.result = Some(format!("Wrote the file.\r\nShip\0ped. {GITHUB}"));
    let change = crate::delegations::settle(&mut conn, settled, at).unwrap();
    assert!(change.applied);

    let rows = outcomes(&conn);
    assert_eq!(rows.len(), 1);
    let line = &rows[0];
    assert_eq!(line.kind, "outcome");
    assert_eq!(line.project, "tally");
    assert_eq!(line.task_id, row.id);
    assert_eq!(line.created_at, at);
    assert!(line.line.starts_with("Done: 保存 the export."));
    assert!(line.line.contains("Delivered: Wrote the file. Shipped."));
    assert!(line.line.contains("No rework."));
    assert!(line.line.contains("1 hour 30 minutes from queued."));
    assert!(!line.line.contains('\n') && !line.line.contains('\r'));
    assert!(line.line.contains("[secret removed]"));
    assert!(!line.line.contains("ghp_"));
    assert!(!scrubber().has_secret(&line.line));
    assert!(!scrubber().has_secret(&line.source));
    let offset = local_offset_seconds(at.div_euclid(1000));
    assert_eq!(line.day, civil_day(at, offset).unwrap());
    assert_eq!(activity_rows(&conn), before);

    let again = crate::delegations::settle(
        &mut conn,
        finish(
            &row.id,
            1,
            crate::delegations::COMPLETED,
            "A different report.",
        ),
        at + 60_000,
    )
    .unwrap();
    assert!(!again.applied);
    assert_eq!(outcomes(&conn).len(), 1);
    assert_eq!(outcomes(&conn)[0].line, line.line);
}

#[test]
fn a_late_settle_a_cancel_and_a_refused_done_write_nothing() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let queued = unix_ms(2026, 11, 10);
    let row =
        crate::delegations::record(&mut conn, launch("req-late", "worker-late"), queued).unwrap();
    let late = crate::delegations::settle(
        &mut conn,
        finish(&row.id, 2, crate::delegations::COMPLETED, "too late"),
        queued + 1_000,
    )
    .unwrap();
    assert!(!late.applied);
    let cancelled = crate::delegations::settle(
        &mut conn,
        finish(&row.id, 1, crate::delegations::CANCELLED, "stopped"),
        queued + 2_000,
    )
    .unwrap();
    assert!(cancelled.applied);
    assert!(outcomes(&conn).is_empty());

    let mut needs_review = launch("req-review", "worker-review");
    needs_review.review_required = true;
    let reviewed = crate::delegations::record(&mut conn, needs_review, queued).unwrap();
    let refused = crate::delegations::settle(
        &mut conn,
        finish(
            &reviewed.id,
            1,
            crate::delegations::COMPLETED,
            "done without a review",
        ),
        queued + 3_000,
    );
    assert!(refused.is_err());
    assert!(outcomes(&conn).is_empty());
}

#[test]
fn a_failure_and_a_send_back_each_write_one_line_and_count_rework() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let queued = unix_ms(2026, 11, 10);
    let row =
        crate::delegations::record(&mut conn, launch("req-back", "worker-back"), queued).unwrap();
    let first = crate::delegations::sent_back(
        &mut conn,
        &row.id,
        1,
        "Wrote a first draft.",
        queued + 20 * 60_000,
    )
    .unwrap()
    .unwrap();
    assert!(first.line.starts_with("Sent back: Save the export."));
    assert!(first.line.contains("Delivered: Wrote a first draft."));
    assert!(first.line.contains("Reworked once."));
    assert!(first.line.contains("20 minutes from queued."));
    let repeat = crate::delegations::sent_back(
        &mut conn,
        &row.id,
        1,
        "A different draft that must not replace the first.",
        queued + 21 * 60_000,
    )
    .unwrap()
    .unwrap();
    assert_eq!(repeat.seq, first.seq);
    assert_eq!(repeat.line, first.line);
    let second = crate::delegations::sent_back(
        &mut conn,
        &row.id,
        2,
        "Wrote a second draft.",
        queued + 40 * 60_000,
    )
    .unwrap()
    .unwrap();
    assert_ne!(second.seq, first.seq);
    assert!(second.line.contains("Reworked 2 times."));

    let mut failed = finish(
        &row.id,
        1,
        crate::delegations::FAILED,
        "Wrote a second draft.",
    );
    failed.error = Some(format!("the checks still failed {PRIVATE_KEY}"));
    let change = crate::delegations::settle(&mut conn, failed, queued + 90 * 60_000).unwrap();
    assert!(change.applied);
    let failed_line = outcomes(&conn)
        .into_iter()
        .find(|line| line.line.starts_with("Failed:"))
        .unwrap();
    assert!(failed_line
        .line
        .contains("Delivered: Wrote a second draft."));
    assert!(failed_line
        .line
        .contains("It failed: the checks still failed"));
    assert!(failed_line.line.contains("[secret removed]"));
    assert!(!failed_line.line.contains("BEGIN OPENSSH"));
    assert!(!scrubber().has_secret(&failed_line.line));
    assert!(failed_line.line.contains("Reworked 2 times."));
    assert!(failed_line.line.contains("1 hour 30 minutes from queued."));

    let resumed =
        crate::delegations::reattach(&mut conn, "worker-back", true, None, queued + 91 * 60_000)
            .unwrap()
            .expect("a failed task can be picked up again");
    assert_eq!(resumed.generation, 2);
    let done = crate::delegations::settle(
        &mut conn,
        finish(&row.id, 2, crate::delegations::COMPLETED, "Wrote the file."),
        queued + ((24 + 4) * 60) * 60_000,
    )
    .unwrap();
    assert!(done.applied);
    let done_line = outcomes(&conn)
        .into_iter()
        .find(|line| line.line.starts_with("Done:"))
        .unwrap();
    assert!(done_line.line.contains("Delivered: Wrote the file."));
    assert!(done_line.line.contains("Reworked 3 times."));
    assert!(done_line.line.contains("1 day 4 hours from queued."));
    assert_eq!(outcomes(&conn).len(), 4);

    assert!(
        crate::delegations::sent_back(&mut conn, &row.id, 3, "too late", queued + 1)
            .unwrap()
            .is_none()
    );
    assert!(
        crate::delegations::sent_back(&mut conn, "missing", 1, "no row", queued)
            .unwrap()
            .is_none()
    );
    assert_eq!(outcomes(&conn).len(), 4);
    let bad = crate::delegations::sent_back(&mut conn, &row.id, 0, "no", queued).unwrap_err();
    assert!(bad.contains("1 to 100"), "{bad}");
    let far = crate::delegations::sent_back(&mut conn, &row.id, 101, "no", queued).unwrap_err();
    assert!(far.contains("1 to 100"), "{far}");
    assert!(crate::delegations::sent_back(&mut conn, "  ", 1, "no", queued).is_err());
}

#[test]
fn a_source_that_looks_like_a_secret_is_not_stored() {
    let secret_id = format!("task-{GITHUB}");
    let done = delegation_source(&secret_id, "done", 1);
    let sent = delegation_source(&secret_id, "sent-back", 2);
    assert!(done.starts_with("delegation:"));
    assert!(sent.starts_with("delegation:sent-back:"));
    assert!(!done.contains("ghp_") && !sent.contains("ghp_"));
    assert!(!scrubber().has_secret(&done) && !scrubber().has_secret(&sent));
    assert_ne!(done, sent);
}

#[test]
fn an_answered_decision_writes_one_line() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let before = activity_rows(&conn);
    let project = format!("tally {GITHUB}");
    crate::decisions::ask(
        &mut conn,
        crate::decisions::AskInput {
            asked_by: "lead-chat".into(),
            asked_by_mono: None,
            project: Some(project.clone()),
            key: "export-format".into(),
            question: "Which export format should we keep?".into(),
            options: vec!["CSV".into(), "JSON".into()],
            recommended: None,
            task_ids: Vec::new(),
            keys: Vec::new(),
            force: false,
            reason: None,
        },
        unix_ms(2026, 11, 10),
    )
    .unwrap();
    let answered = crate::decisions::answer(
        &mut conn,
        &project,
        "export-format",
        &format!("Keep CSV. {ASSIGNED}"),
        None,
        unix_ms(2026, 11, 10) + 60_000,
    )
    .unwrap();
    assert!(answered.applied);
    let rows = decisions(&conn);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "decision");
    assert!(rows[0].line.contains("Which export format should we keep?"));
    assert!(rows[0].line.contains("Keep CSV."));
    assert!(rows[0].line.contains("[secret removed]"));
    assert!(!rows[0].line.contains("Planted9"));
    assert!(!rows[0].source.contains("ghp_"));
    assert!(!scrubber().has_secret(&rows[0].line));
    assert!(!scrubber().has_secret(&rows[0].source));
    assert!(!scrubber().has_secret(&rows[0].project));
    assert_eq!(activity_rows(&conn), before);

    let second = crate::decisions::answer(
        &mut conn,
        &project,
        "export-format",
        "JSON",
        None,
        unix_ms(2026, 11, 10) + 120_000,
    )
    .unwrap();
    assert!(!second.applied);
    assert_eq!(decisions(&conn).len(), 1);
    assert!(decisions(&conn)[0].line.contains("Keep CSV."));

    crate::decisions::ask(
        &mut conn,
        crate::decisions::AskInput {
            asked_by: "lead-chat".into(),
            asked_by_mono: None,
            project: Some("tally".into()),
            key: "irreversible/lead/task".into(),
            question: "Delete the export history?".into(),
            options: vec!["Keep it".into(), "Delete it".into()],
            recommended: None,
            task_ids: Vec::new(),
            keys: Vec::new(),
            force: false,
            reason: None,
        },
        unix_ms(2026, 11, 10),
    )
    .unwrap();
    let refused = crate::decisions::answer(
        &mut conn,
        "tally",
        "irreversible/lead/task",
        "Delete it",
        Some("chat:mate".into()),
        unix_ms(2026, 11, 10) + 1_000,
    );
    assert!(refused.is_err());
    assert_eq!(decisions(&conn).len(), 1);
    let still = crate::decisions::get(&conn, "tally", "irreversible/lead/task")
        .unwrap()
        .unwrap();
    assert_eq!(still.state, crate::decisions::OPEN);
}

/// A journal that cannot be written: the table is there, but it refuses every insert.
fn break_the_journal(conn: &Connection) {
    conn.execute_batch(
        "CREATE TRIGGER work_log_test_refuses_insert
         BEFORE INSERT ON work_log
         BEGIN
           SELECT RAISE(ABORT, 'the journal is broken');
         END;",
    )
    .unwrap();
}

fn stored_task_state(conn: &Connection, id: &str) -> String {
    conn.query_row("SELECT state FROM delegations WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn a_broken_work_log_does_not_stop_a_task_from_finishing() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    break_the_journal(&conn);
    let queued = unix_ms(2026, 11, 10);
    for (index, state) in [crate::delegations::COMPLETED, crate::delegations::FAILED]
        .into_iter()
        .enumerate()
    {
        let row = crate::delegations::record(
            &mut conn,
            launch(
                &format!("req-broken-{index}"),
                &format!("worker-broken-{index}"),
            ),
            queued,
        )
        .unwrap();
        let change = crate::delegations::settle(
            &mut conn,
            finish(&row.id, 1, state, "Wrote the file."),
            queued + 60_000,
        )
        .expect("a journal that cannot be written must not fail the finish");
        assert!(change.applied, "{state}");
        assert_eq!(stored_task_state(&conn, &row.id), state);
        assert_eq!(change.row.unwrap().state, state);
    }
    assert!(outcomes(&conn).is_empty());
}

#[test]
fn a_broken_work_log_does_not_stop_an_answer_from_landing() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    break_the_journal(&conn);
    let at = unix_ms(2026, 11, 10);
    crate::decisions::ask(
        &mut conn,
        crate::decisions::AskInput {
            asked_by: "lead-chat".into(),
            asked_by_mono: None,
            project: Some("tally".into()),
            key: "export-format".into(),
            question: "Which export format should we keep?".into(),
            options: vec!["CSV".into(), "JSON".into()],
            recommended: None,
            task_ids: Vec::new(),
            keys: Vec::new(),
            force: false,
            reason: None,
        },
        at,
    )
    .unwrap();
    let answered = crate::decisions::answer(
        &mut conn,
        "tally",
        "export-format",
        "Keep CSV.",
        None,
        at + 60_000,
    )
    .expect("a journal that cannot be written must not fail the answer");
    assert!(answered.applied);
    // The asker still hears the answer: the rest of the transaction was kept.
    assert_eq!(answered.released.len(), 1);
    let stored = crate::decisions::get(&conn, "tally", "export-format")
        .unwrap()
        .unwrap();
    assert_eq!(stored.state, crate::decisions::ANSWERED);
    assert_eq!(stored.answer.as_deref(), Some("Keep CSV."));
    assert!(decisions(&conn).is_empty());
}

#[test]
fn a_failed_journal_write_rolls_back_only_its_own_savepoint() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    conn.execute_batch("CREATE TABLE scratch (n INTEGER)")
        .unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute("INSERT INTO scratch VALUES (1)", []).unwrap();
    let skipped: Option<()> = best_effort(&tx, "scratch", |inner| {
        inner
            .execute("INSERT INTO scratch VALUES (2)", [])
            .map_err(|e| e.to_string())?;
        Err("the second write broke".to_string())
    });
    assert!(skipped.is_none());
    // The savepoint is gone, so the name is free for the next write, and the transaction is still open.
    let kept = best_effort(&tx, "scratch", |inner| {
        inner
            .execute("INSERT INTO scratch VALUES (3)", [])
            .map_err(|e| e.to_string())
    });
    assert_eq!(kept, Some(1));
    tx.commit().unwrap();
    let rows: Vec<i64> = conn
        .prepare("SELECT n FROM scratch ORDER BY n")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows, vec![1, 3]);
}

#[test]
fn a_journal_that_works_is_written_through_the_savepoint() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let line = best_effort(&conn, "note", |inner| {
        record_decision(inner, "tally", "k", "Which one?", "This one", 1_000)
    })
    .expect("a working journal writes its line");
    assert!(line.line.contains("Which one?"));
    assert_eq!(decisions(&conn).len(), 1);
}

#[test]
fn two_windows_keep_one_line_for_one_decision_and_one_send_back() {
    let temp = TempDb::new();
    let task_id = {
        let store = SessionStore::open(temp.db.clone()).unwrap();
        let mut conn = store.lock_conn().unwrap();
        crate::decisions::ask(
            &mut conn,
            crate::decisions::AskInput {
                asked_by: "lead-chat".into(),
                asked_by_mono: None,
                project: Some("tally".into()),
                key: "export-format".into(),
                question: "Which export format should we keep?".into(),
                options: vec!["CSV".into(), "JSON".into()],
                recommended: None,
                task_ids: Vec::new(),
                keys: Vec::new(),
                force: false,
                reason: None,
            },
            1_000,
        )
        .unwrap();
        crate::delegations::record(&mut conn, launch("req-race", "worker-race"), 1_000)
            .unwrap()
            .id
    };
    let answers = ["CSV", "JSON"];
    std::thread::scope(|scope| {
        for (index, word) in answers.iter().enumerate() {
            let path = temp.db.clone();
            let word = *word;
            scope.spawn(move || {
                let mut conn = Connection::open(&path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                let _ = crate::decisions::answer(
                    &mut conn,
                    "tally",
                    "export-format",
                    word,
                    None,
                    2_000 + index as i64,
                );
            });
        }
        for index in 0..8 {
            let path = temp.db.clone();
            let task_id = task_id.clone();
            scope.spawn(move || {
                let mut conn = Connection::open(&path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                let _ = crate::delegations::sent_back(
                    &mut conn,
                    &task_id,
                    1,
                    &format!("Draft {index}."),
                    3_000 + index,
                );
            });
        }
    });
    let conn = Connection::open(&temp.db).unwrap();
    let decided = decisions(&conn);
    assert_eq!(decided.len(), 1);
    let stored = crate::decisions::get(&conn, "tally", "export-format")
        .unwrap()
        .unwrap();
    assert_eq!(stored.state, crate::decisions::ANSWERED);
    let answer = stored.answer.unwrap();
    assert!(
        answer == "CSV" || answer == "JSON",
        "unexpected answer {answer}"
    );
    assert!(decided[0].line.contains(&answer));
    let sent = outcomes(&conn)
        .into_iter()
        .filter(|line| line.line.starts_with("Sent back:"))
        .collect::<Vec<_>>();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].line.contains("Reworked once."));
    assert!(sent[0].line.starts_with("Sent back: Save the export."));
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

#[test]
fn a_repeated_judgment_keeps_the_first_line_and_a_secret_is_not_stored() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let at = unix_ms(2026, 11, 10);
    let first = add_hand(
        &conn,
        "chat-lead",
        "tally",
        "feedback",
        "Ash said keep the CSV.",
        at,
    )
    .unwrap();
    let again = add_hand(
        &conn,
        "chat-lead",
        " tally ",
        "feedback",
        "Ash said\r\nkeep the CSV.",
        at + 5_000,
    )
    .unwrap();
    assert_eq!(again.seq, first.seq);
    assert_eq!(again.line, "Ash said keep the CSV.");
    assert!(!again.source.is_empty());
    let other_kind = add_hand(
        &conn,
        "chat-lead",
        "tally",
        "context",
        "Ash said keep the CSV.",
        at,
    )
    .unwrap();
    assert_ne!(other_kind.seq, first.seq);
    let later = add_hand(
        &conn,
        "chat-lead",
        "tally",
        "feedback",
        "Ash said keep the CSV.",
        unix_ms(2026, 11, 12),
    )
    .unwrap();
    assert_ne!(later.day, first.day);
    let saved = add_hand(
        &conn,
        "chat-lead",
        "tally",
        "feedback",
        "保存 the export",
        at,
    )
    .unwrap();
    assert_eq!(saved.line, "保存 the export");
    let secret = add_hand(
        &conn,
        "chat-lead",
        "tally",
        "feedback",
        &format!("The token is {GITHUB}"),
        at,
    )
    .unwrap();
    assert!(secret.line.contains("[secret removed]"));
    assert!(!secret.line.contains("ghp_"));
    assert!(!secret.source.contains("ghp_"));
    assert!(!scrubber().has_secret(&secret.source));
    assert!(!scrubber().has_secret(&secret.line));
    let page = "a".repeat(HAND_INPUT_CAP + 1);
    assert_eq!(
        add_hand(&conn, "chat-lead", "tally", "context", &page, at).unwrap_err(),
        "A work log line is one line, not a page."
    );
    let long = "b".repeat(2_500);
    let capped = add_hand(&conn, "chat-lead", "tally", "context", &long, at).unwrap();
    assert_eq!(capped.line.chars().count(), LINE_CAP);
    assert_eq!(
        add_hand(&conn, " ", "tally", "feedback", "A line.", at).unwrap_err(),
        "There's no chat for this line."
    );
    assert_eq!(
        add_hand(&conn, "chat-lead", "tally", "note", "A line.", at).unwrap_err(),
        "Work log lines are an outcome, a decision, feedback or context."
    );
}

#[test]
fn a_read_is_one_day_or_a_range_and_can_name_a_project() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let at = unix_ms(2026, 7, 15);
    let tally = add_hand(
        &conn,
        "chat-lead",
        "tally",
        "outcome",
        "Shipped the export.",
        at,
    )
    .unwrap();
    add_hand(
        &conn,
        "chat-lead",
        "other",
        "outcome",
        "Shipped the other one.",
        at,
    )
    .unwrap();
    let day = tally.day.as_str();
    let one = read_span(&conn, Some("tally"), Some(day), None, None).unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].line, "Shipped the export.");
    assert!(one[0].task_id.is_empty());
    let all = read_span(&conn, None, Some(day), None, None).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(
        read_span(&conn, Some("  "), Some(day), None, None).unwrap_err(),
        "Name a project, or leave it out to read every project."
    );
    assert_eq!(
        read_span(&conn, Some(GITHUB), Some(day), None, None).unwrap_err(),
        "That project name could not be used."
    );
    let long_name = "p".repeat(FIELD_CAP + 1);
    assert_eq!(
        read_span(&conn, Some(&long_name), Some(day), None, None).unwrap_err(),
        "That project name could not be used."
    );
    assert_eq!(
        read_span(&conn, None, None, None, None).unwrap_err(),
        "Say which day to read, or from and to."
    );
    assert_eq!(
        read_span(&conn, None, Some(day), Some(day), None).unwrap_err(),
        "Give a day, or from and to, not both."
    );
    assert_eq!(
        read_span(&conn, None, None, Some("2026-11-10"), Some("2026-11-01")).unwrap_err(),
        "The end day is before the start day."
    );
    assert_eq!(
        read_span(&conn, None, Some("2026-02-31"), None, None).unwrap_err(),
        "The day should look like 2026-11-10."
    );
    assert_eq!(
        read_span(&conn, None, Some("tomorrow"), None, None).unwrap_err(),
        "The day should look like 2026-11-10."
    );
    assert!(
        read_span(&conn, None, None, Some("2020-03-01"), Some("2020-06-01"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        read_span(&conn, None, None, Some("2026-01-01"), Some("2027-01-03")).unwrap_err(),
        "Read one day, or a range of at most a year."
    );
    let missing = read_span(&conn, None, Some("2020-01-01"), None, None).unwrap();
    assert!(missing.is_empty());
}

#[test]
fn two_windows_keep_one_hand_line() {
    let temp = TempDb::new();
    {
        let store = SessionStore::open(temp.db.clone()).unwrap();
        drop(store.lock_conn().unwrap());
    }
    let at = unix_ms(2026, 11, 10);
    let lines: Vec<Line> = std::thread::scope(|scope| {
        let mut joins = Vec::new();
        for _ in 0..8 {
            let path = temp.db.clone();
            joins.push(scope.spawn(move || {
                let conn = Connection::open(&path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                add_hand(
                    &conn,
                    "chat-lead",
                    "tally",
                    "feedback",
                    "Ash said keep the CSV.",
                    at,
                )
                .unwrap()
            }));
        }
        joins.into_iter().map(|join| join.join().unwrap()).collect()
    });
    let seq = lines[0].seq;
    assert!(lines
        .iter()
        .all(|line| line.seq == seq && line.line == "Ash said keep the CSV."));
    let conn = Connection::open(&temp.db).unwrap();
    let rows = read_span(&conn, Some("tally"), Some(&lines[0].day), None, None).unwrap();
    assert_eq!(rows.len(), 1);
}
