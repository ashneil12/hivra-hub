use std::sync::Arc;
use std::thread;

use rusqlite::Connection;
use serde_json::json;

use super::*;
use crate::portable::scrubber;
use crate::session_store::{now_millis, SessionStore};

const NOW: i64 = 1_700_000_000_000;
const ANTHROPIC: &str = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
const GITHUB: &str = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";
const PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAPLANTED\n-----END OPENSSH PRIVATE KEY-----";
const ASSIGNED: &str = "password = Planted9Secret9Value9X";

fn memory() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn write(
    conn: &Connection,
    kind: &str,
    actor: &Who,
    initiator: &Who,
    project: &str,
    summary: &str,
    at: i64,
) -> Entry {
    record(
        conn,
        kind,
        actor,
        initiator,
        project,
        "acme/web#7",
        summary,
        "",
        at,
    )
    .unwrap()
}

#[test]
fn the_table_arrives_with_the_schema_and_a_row_cannot_be_changed() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let row = write(
        &conn,
        MERGE,
        &Who::person(),
        &Who::person(),
        "tally",
        "Merged acme/web#7.",
        NOW,
    );
    let err = conn
        .execute(
            "UPDATE activity SET summary = 'rewritten' WHERE seq = ?1",
            [row.seq],
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("append-only"), "{err}");
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].summary, "Merged acme/web#7.");
    assert_eq!(page.entries[0].id, row.id);
}

#[test]
fn a_second_row_does_not_change_the_first() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let first = write(
        &conn,
        MERGE,
        &Who::person(),
        &Who::person(),
        "tally",
        "Merged the first.",
        NOW,
    );
    let second = write(
        &conn,
        MERGE,
        &Who::person(),
        &Who::person(),
        "tally",
        "Merged the second.",
        NOW,
    );
    assert_ne!(first.seq, second.seq);
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    assert_eq!(page.entries.len(), 2);
    assert_eq!(page.entries[1].summary, "Merged the first.");
    assert_eq!(page.entries[0].summary, "Merged the second.");
}

#[test]
fn retention_keeps_the_row_on_the_boundary_and_drops_the_one_before_it() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let edge = NOW - RETENTION_MS;
    write(
        &conn,
        MERGE,
        &Who::app(),
        &Who::person(),
        "",
        "On the boundary.",
        edge,
    );
    write(
        &conn,
        MERGE,
        &Who::app(),
        &Who::person(),
        "",
        "One millisecond older.",
        edge - 1,
    );
    write(
        &conn,
        PUSH,
        &Who::app(),
        &Who::person(),
        "",
        "Just now.",
        NOW,
    );
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    let summaries: Vec<_> = page.entries.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(
        summaries,
        ["Just now.", "On the boundary."],
        "{summaries:?}"
    );
}

#[test]
fn a_far_future_stamp_does_not_delete_rows_that_are_still_kept() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    write(
        &conn,
        MERGE,
        &Who::person(),
        &Who::person(),
        "",
        "Still kept.",
        NOW,
    );
    write(
        &conn,
        MERGE,
        &Who::person(),
        &Who::person(),
        "",
        "Stamped next year.",
        NOW + 400 * super::DAY_MS,
    );
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    assert!(
        page.entries.iter().any(|e| e.summary == "Still kept."),
        "{:?}",
        page.entries
    );
}

#[test]
fn a_clock_ahead_of_the_stored_rows_does_not_wipe_them_on_list_or_import() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    write(
        &conn,
        MERGE,
        &Who::person(),
        &Who::person(),
        "",
        "Still kept.",
        NOW,
    );
    write(
        &conn,
        PUSH,
        &Who::person(),
        &Who::person(),
        "",
        "Eighty nine days old.",
        NOW - 89 * DAY_MS,
    );
    // Two days fast is enough to push an 89-day-old row over the 90-day cut
    // when the list uses the raw clock. A clock months ahead wipes every row.
    for ahead in [2 * DAY_MS, 200 * DAY_MS] {
        let page = list(&conn, &ListQuery::default(), NOW + ahead).unwrap();
        let summaries: Vec<_> = page.entries.iter().map(|e| e.summary.as_str()).collect();
        assert!(
            summaries.contains(&"Still kept.") && summaries.contains(&"Eighty nine days old."),
            "clock {ahead} ms ahead left {summaries:?}"
        );
    }

    let imported = json!({
        "id": "imported-1",
        "kind": MERGE,
        "actor_role": "person",
        "initiator_role": "person",
        "summary": "Imported and still kept.",
        "at": NOW,
    });
    assert_eq!(
        import_rows_at(&conn, std::slice::from_ref(&imported), NOW + 200 * DAY_MS).unwrap(),
        1
    );
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    let summaries: Vec<_> = page.entries.iter().map(|e| e.summary.as_str()).collect();
    assert!(
        summaries.contains(&"Imported and still kept.")
            && summaries.contains(&"Still kept.")
            && summaries.contains(&"Eighty nine days old."),
        "{summaries:?}"
    );
}

#[test]
fn a_summary_keeps_no_secret_the_scrubber_knows() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let raw = format!(
        "Pushed the branch. {ANTHROPIC} {GITHUB} {PRIVATE_KEY} {ASSIGNED} Bearer abcdefghij1234567890 token and https://ada:S3cret1@example.com and xoxb-1234567890-abcdefghij"
    );
    assert!(
        !scrubber().findings(&raw).is_empty(),
        "the sample must trip the scrubber or the test proves nothing"
    );
    let row = write(&conn, PUSH, &Who::person(), &Who::person(), "", &raw, NOW);
    assert!(
        scrubber().findings(&row.summary).is_empty(),
        "{}",
        row.summary
    );
    for needle in [
        "sk-ant-",
        "ghp_",
        "BEGIN OPENSSH",
        "Planted9",
        "abcdefghij1234567890",
        "S3cret1",
        "xoxb-",
    ] {
        assert!(
            !row.summary.contains(needle),
            "{needle} survived in {}",
            row.summary
        );
    }
    assert!(row.summary.contains("[secret removed]"), "{}", row.summary);
}

#[test]
fn a_secret_past_the_cut_is_removed_before_the_summary_is_shortened() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let raw = format!("{} {GITHUB}", "n".repeat(490));
    let row = write(&conn, PUSH, &Who::app(), &Who::person(), "", &raw, NOW);
    assert!(row.summary.chars().count() <= super::MAX_SUMMARY_CHARS);
    assert!(!row.summary.contains("ghp_"), "{}", row.summary);
    assert!(!row.summary.contains("PLANTED"), "{}", row.summary);
    assert!(scrubber().findings(&row.summary).is_empty());
    assert!(!row.summary.ends_with(&"n".repeat(20)));
}

#[test]
fn empty_odd_and_untrusted_values_fall_back() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let row = record(
        &conn,
        MERGE,
        &Who::first_mate("  ", "Ada"),
        &Who::worker("worker-1", "Bo"),
        "  C:\\Users\\Ada\\My Project\\..\\café  \r\n",
        "",
        " \r\n\0 ",
        "session:chat-1",
        NOW,
    )
    .unwrap();
    assert_eq!(row.summary, "Recorded.");
    assert_eq!(row.actor, Who::App);
    assert_eq!(
        row.initiator,
        Who::Worker {
            id: "worker-1".into(),
            name: "Bo".into(),
        }
    );
    assert_eq!(row.project, "C:\\Users\\Ada\\My Project\\..\\café");
    assert_eq!(row.link, "session:chat-1");

    assert!(record(
        &conn,
        "Git.Merge",
        &Who::person(),
        &Who::person(),
        "",
        "",
        "No.",
        "",
        NOW,
    )
    .is_err());
    assert!(record(
        &conn,
        "a..b",
        &Who::person(),
        &Who::person(),
        "",
        "",
        "No.",
        "",
        NOW,
    )
    .is_err());
    assert!(record(
        &conn,
        "",
        &Who::person(),
        &Who::person(),
        "",
        "",
        "No.",
        "",
        NOW,
    )
    .is_err());
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    assert_eq!(page.entries.len(), 1);

    conn.execute(
        "INSERT INTO activity (id, kind, actor_role, actor_id, actor_name, initiator_role, initiator_id, initiator_name, project, target, summary, link, at)
         VALUES ('badrole1', 'git.merge', 'root', 'x', 'Root', 'nope', '', '', '', '', 'From disk.', '', ?1)",
        [NOW + 1],
    )
    .unwrap();
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    let bad = page.entries.iter().find(|e| e.id == "badrole1").unwrap();
    assert_eq!(bad.actor, Who::App);
    assert_eq!(bad.initiator, Who::App);
    assert_eq!(bad.summary, "From disk.");
}

#[test]
fn filters_search_and_the_cursor_agree() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    record(
        &conn,
        MERGE,
        &Who::first_mate("lead-1", "Ada"),
        &Who::person(),
        "tally",
        "acme/web#7",
        "Merged the tally branch.",
        "https://github.com/acme/web/pull/7",
        NOW,
    )
    .unwrap();
    record(
        &conn,
        PLUGIN_INSTALL,
        &Who::app(),
        &Who::mono("mono-9", "Nia"),
        "other",
        "pstack",
        "Installed pstack.",
        "",
        NOW - 1,
    )
    .unwrap();
    record(
        &conn,
        PUSH,
        &Who::worker("worker-2", "Bo"),
        &Who::person(),
        "tally",
        "100%_done",
        "Pushed 100%_done.",
        "",
        NOW - 2,
    )
    .unwrap();

    let tally = list(
        &conn,
        &ListQuery {
            project: Some("tally".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(tally.entries.len(), 2);
    assert!(tally.entries.iter().all(|e| e.project == "tally"));

    let ada = list(
        &conn,
        &ListQuery {
            agent: Some("ada".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(ada.entries.len(), 1);
    assert_eq!(ada.entries[0].kind, MERGE);

    let asked = list(
        &conn,
        &ListQuery {
            agent: Some("mono-9".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(asked.entries.len(), 1);
    assert_eq!(asked.entries[0].kind, PLUGIN_INSTALL);

    let kind = list(
        &conn,
        &ListQuery {
            kind: Some(PUSH.into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(kind.entries.len(), 1);

    let literal = list(
        &conn,
        &ListQuery {
            search: Some("100%_done".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(literal.entries.len(), 1);
    assert_eq!(literal.entries[0].kind, PUSH);

    let percent = list(
        &conn,
        &ListQuery {
            search: Some("%".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(percent.entries.len(), 1, "a percent sign is not a wildcard");
    assert_eq!(percent.entries[0].kind, PUSH);
    let underscore = list(
        &conn,
        &ListQuery {
            search: Some("1_0".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert!(
        underscore.entries.is_empty(),
        "an underscore is not a single-character wildcard: {:?}",
        underscore.entries
    );

    let first = list(
        &conn,
        &ListQuery {
            limit: Some(2),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(first.entries.len(), 2);
    let next = first.next.expect("another page");
    let second = list(
        &conn,
        &ListQuery {
            limit: Some(2),
            before: Some(next),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(second.entries.len(), 1);
    assert_eq!(second.entries[0].kind, PUSH);
    assert!(second.next.is_none());
    assert_ne!(first.entries[0].id, second.entries[0].id);

    let huge = list(
        &conn,
        &ListQuery {
            limit: Some(10_000),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(huge.entries.len(), 3);
}

#[test]
fn two_connections_both_keep_their_rows() {
    let dir = std::env::temp_dir().join(format!(
        "hivra-activity-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("monocode.db");
    let first = SessionStore::open(path.clone()).unwrap();
    let second = SessionStore::open(path).unwrap();
    let left = Arc::new(first);
    let right = Arc::new(second);
    let spawn = |store: Arc<SessionStore>, label: &'static str| {
        thread::spawn(move || {
            let conn = store.lock_conn().unwrap();
            for n in 0..20 {
                record(
                    &conn,
                    MERGE,
                    &Who::person(),
                    &Who::person(),
                    label,
                    "",
                    &format!("{label}-{n}"),
                    "",
                    NOW,
                )
                .unwrap();
            }
        })
    };
    let a = spawn(left.clone(), "left");
    let b = spawn(right.clone(), "right");
    a.join().unwrap();
    b.join().unwrap();
    let page = list(
        &left.lock_conn().unwrap(),
        &ListQuery {
            limit: Some(200),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(page.entries.len(), 40);
    assert_eq!(
        page.entries.iter().filter(|e| e.project == "left").count(),
        20
    );
    assert_eq!(
        page.entries.iter().filter(|e| e.project == "right").count(),
        20
    );
    drop(page);
    drop(left);
    drop(right);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_note_on_a_database_without_the_table_writes_nothing() {
    let dir = std::env::temp_dir().join(format!(
        "hivra-activity-note-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let missing = dir.join("missing.db");
    note_db(
        &missing,
        MERGE,
        &Who::person(),
        &Who::person(),
        "",
        "",
        "Should not create a file.",
        "",
    );
    assert!(!missing.exists());

    let bare = dir.join("bare.db");
    {
        let conn = Connection::open(&bare).unwrap();
        conn.execute_batch("CREATE TABLE dummy (id INTEGER);")
            .unwrap();
    }
    note_db(
        &bare,
        MERGE,
        &Who::person(),
        &Who::person(),
        "",
        "",
        &format!("secret {GITHUB}"),
        "",
    );
    let conn = Connection::open(&bare).unwrap();
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'activity'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn orbit_bounds_text_by_characters_and_drops_a_metadata_blob_that_does_not_fit() {
    assert_eq!(bounded_text("ééé", 2), "éé");
    assert_eq!(bounded_text("a\u{1F600}b", 2), "a\u{1F600}");
    assert_eq!(bounded_metadata(&json!({"ok": true})), "{\"ok\":true}");
    let huge = Value::String("x".repeat(3_000));
    assert_eq!(bounded_metadata(&huge), "{\"truncated\":true}");
}

#[test]
fn export_round_trips_without_the_sequence_and_a_second_import_adds_nothing() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let at = now_millis();
    record(
        &conn,
        MERGE,
        &Who::first_mate("lead-1", "Ada"),
        &Who::person(),
        "C:\\Users\\A B\\..\\café",
        "acme/web#7",
        "Merged it.",
        "session:chat 1",
        at,
    )
    .unwrap();
    let rows = export_rows(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].get("seq").is_none());
    assert_eq!(
        rows[0]["project"].as_str().unwrap(),
        "C:\\Users\\A B\\..\\café"
    );
    let other = memory();
    let into = other.lock_conn().unwrap();
    assert_eq!(import_rows(&into, &rows).unwrap(), 1);
    assert_eq!(import_rows(&into, &rows).unwrap(), 0);
    let page = list(&into, &ListQuery::default(), now_millis()).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].summary, "Merged it.");
    assert_eq!(page.entries[0].actor, Who::first_mate("lead-1", "Ada"));

    let poisoned = json!({
        "id": "poison1",
        "kind": MERGE,
        "actor_role": "person",
        "initiator_role": "person",
        "summary": format!("Opened it with {GITHUB}"),
        "at": at,
    });
    assert_eq!(import_rows(&into, &[poisoned]).unwrap(), 1);
    let page = list(&into, &ListQuery::default(), now_millis()).unwrap();
    let poisoned = page.entries.iter().find(|e| e.id == "poison1").unwrap();
    assert!(!poisoned.summary.contains("ghp_"), "{}", poisoned.summary);
    assert!(scrubber().findings(&poisoned.summary).is_empty());

    let changed = json!({
        "id": "poison1",
        "kind": MERGE,
        "actor_role": "person",
        "initiator_role": "person",
        "summary": "Rewritten on import.",
        "at": at,
    });
    assert_eq!(import_rows(&into, &[changed]).unwrap(), 0);
    let page = list(&into, &ListQuery::default(), now_millis()).unwrap();
    let poisoned = page.entries.iter().find(|e| e.id == "poison1").unwrap();
    assert_ne!(poisoned.summary, "Rewritten on import.");

    let junk = json!([
        {"kind": MERGE, "summary": "no id", "at": at},
        {"id": "../etc/passwd", "kind": MERGE, "summary": "bad id", "at": at},
        {"id": "x", "kind": "Not.A.Kind", "summary": "bad kind", "at": at},
        {"id": "y", "kind": MERGE, "summary": "bad time", "at": "yesterday"},
        {"id": "old1", "kind": MERGE, "actor_role": "person", "initiator_role": "person", "summary": "too old", "at": at - RETENTION_MS - 1},
    ]);
    let before = page.entries.len();
    assert_eq!(import_rows(&into, junk.as_array().unwrap()).unwrap(), 0);
    let page = list(&into, &ListQuery::default(), now_millis()).unwrap();
    assert_eq!(page.entries.len(), before);
}

#[test]
fn a_failed_note_does_not_panic() {
    let conn = Connection::open_in_memory().unwrap();
    note(
        &conn,
        MERGE,
        &Who::person(),
        &Who::person(),
        "",
        "",
        &format!("secret {GITHUB}"),
        "",
        NOW,
    );
}

#[test]
fn the_same_moment_orders_the_later_row_first() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    write(
        &conn,
        MERGE,
        &Who::person(),
        &Who::person(),
        "",
        "First.",
        NOW,
    );
    write(
        &conn,
        PUSH,
        &Who::person(),
        &Who::person(),
        "",
        "Second.",
        NOW,
    );
    let page = list(
        &conn,
        &ListQuery {
            limit: Some(1),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(page.entries[0].summary, "Second.");
    let rest = list(
        &conn,
        &ListQuery {
            limit: Some(1),
            before: page.next,
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(rest.entries[0].summary, "First.");
}

#[test]
fn a_mono_records_its_own_note_and_a_blank_or_huge_one_is_refused() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    record_mono_note(
        &conn,
        "worker.default",
        "Its workers use Opus at high effort.",
        "vg-game",
        "mono",
        "vg-game-lead",
        "EXO lead",
        NOW,
    )
    .unwrap();
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    assert_eq!(page.entries.len(), 1);
    let row = &page.entries[0];
    assert_eq!(row.kind, "worker.default");
    assert_eq!(row.actor, Who::mono("vg-game-lead", "EXO lead"));
    assert_eq!(row.initiator, Who::person());
    assert_eq!(row.project, "vg-game");
    assert_eq!(row.target, "mono");
    assert_eq!(row.summary, "Its workers use Opus at high effort.");
    assert!(record_mono_note(
        &conn,
        "worker.default",
        "  ",
        "vg-game",
        "mono",
        "vg-game-lead",
        "EXO lead",
        NOW,
    )
    .is_err());
    let huge = "x".repeat(501);
    assert!(record_mono_note(
        &conn,
        "worker.default",
        &huge,
        "vg-game",
        "mono",
        "vg-game-lead",
        "EXO lead",
        NOW,
    )
    .is_err());
    let long_name = "p".repeat(501);
    assert!(record_mono_note(
        &conn,
        "worker.default",
        "Kept.",
        &long_name,
        "mono",
        "vg-game-lead",
        "EXO lead",
        NOW,
    )
    .is_err());
    assert!(record_mono_note(
        &conn,
        "worker.default",
        "Kept.",
        "vg-game",
        "mono",
        "  ",
        "EXO lead",
        NOW,
    )
    .is_err());
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    assert_eq!(page.entries.len(), 1);
}

#[test]
fn a_first_mate_report_drops_control_characters_before_it_is_stored() {
    let store = memory();
    let conn = store.lock_conn().unwrap();
    let err = record_first_mate_note(
        &conn,
        "protected.report",
        "\n\t",
        "project",
        "target",
        "lead-1",
        "Ada",
        NOW,
    )
    .unwrap_err();
    assert!(err.contains("summary"), "{err}");
    record_first_mate_note(
        &conn,
        "protected.report",
        "Touched\n ~/.ssh",
        "pro\u{0007}ject",
        "tar\rget",
        "lead-1",
        "Ada",
        NOW,
    )
    .unwrap();
    let page = list(&conn, &ListQuery::default(), NOW).unwrap();
    assert_eq!(page.entries.len(), 1);
    let row = &page.entries[0];
    assert_eq!(row.summary, "Touched ~/.ssh");
    assert_eq!(row.project, "project");
    assert_eq!(row.target, "target");
    assert_eq!(row.kind, "protected.report");
}
