use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;

use super::store::*;

fn actor(kind: &str, project: &str) -> Actor {
    Actor {
        id: kind.into(),
        project: project.into(),
        kind: kind.into(),
    }
}

fn mate() -> Actor {
    actor("first-mate", "crew")
}

fn person() -> Actor {
    actor("person", "crew")
}

fn worker() -> Actor {
    actor("worker", "crew")
}

fn input(wp: &str, title: &str) -> EnqueueInput {
    EnqueueInput {
        wp: wp.into(),
        title: title.into(),
        brief_path: format!("docs/briefs/{wp}.md"),
        branch: format!("wp/{wp}"),
        priority: None,
        notes: None,
        security_park: false,
    }
}

fn open_db(path: &Path) -> Connection {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let conn = Connection::open(path).unwrap();
    conn.busy_timeout(Duration::from_secs(2)).unwrap();
    conn.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
    ensure_tables(&conn).unwrap();
    conn
}

struct TempDb {
    dir: PathBuf,
}

impl TempDb {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("hivra-programme-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("programme.db")
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let Ok(temp) = crate::fs::canonical(std::env::temp_dir()) else {
            return;
        };
        let Ok(dir) = crate::fs::canonical(&self.dir) else {
            return;
        };
        if dir.starts_with(temp) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    ensure_tables(&conn).unwrap();
    conn
}

#[test]
fn append_claim_finish_and_park_round_trip() {
    let mut conn = memory();
    let who = mate();
    let row = enqueue(&mut conn, &who, &input("WP-159", "Programme queue"), 10).unwrap();
    assert_eq!(row.status, "queued");
    assert_eq!(row.version, 1);
    assert_eq!(row.brief_path, "docs/briefs/WP-159.md");
    assert_eq!(row.branch, "wp/WP-159");

    let claimed = claim(&mut conn, &who, &row.id, row.version, 20).unwrap();
    assert_eq!(claimed.status, "building");
    assert_eq!(claimed.claimed_at, Some(20));
    assert_eq!(claimed.version, 2);

    let again = claim(&mut conn, &who, &row.id, row.version, 21);
    assert!(again.unwrap_err().contains("Read it again"));
    assert_eq!(get(&conn, &who, &row.id).unwrap().status, "building");

    let open = finish(&mut conn, &who, &row.id, claimed.version, "pr_open", 30).unwrap();
    assert_eq!(open.status, "pr_open");
    assert_eq!(open.finished_at, None);
    assert_eq!(open.claimed_at, Some(20));

    let parked = park(
        &mut conn,
        &who,
        &row.id,
        open.version,
        "Needs a look",
        false,
        40,
    )
    .unwrap();
    assert_eq!(parked.status, "parked");
    assert_eq!(parked.park_reason.as_deref(), Some("Needs a look"));
    let stayed = finish(&mut conn, &who, &row.id, parked.version, "merged", 41).unwrap_err();
    assert!(stayed.contains("stays parked"));
    assert_eq!(get(&conn, &who, &row.id).unwrap().status, "parked");

    let refused = clear_park(&mut conn, &who, &row.id, parked.version, 42).unwrap_err();
    assert!(refused.contains("until the person clears"));
    assert_eq!(get(&conn, &who, &row.id).unwrap().status, "parked");

    let cleared = clear_park(&mut conn, &person(), &row.id, parked.version, 43).unwrap();
    assert_eq!(cleared.status, "queued");
    assert_eq!(cleared.park_reason, None);
    assert_eq!(cleared.claimed_at, None);
    assert!(!cleared.security_park);
}

#[test]
fn enqueue_refuses_a_branch_that_was_not_made_for_the_package() {
    let mut conn = memory();
    let who = mate();

    let mut foreign = input("WP-162", "Update leftovers");
    foreign.branch = "ash/notes".into();
    let err = enqueue(&mut conn, &who, &foreign, 1).unwrap_err();
    assert!(
        err.contains("not made for this package"),
        "queued a branch that is not this package's: {err}"
    );
    assert!(list(&conn, &who).unwrap().is_empty());

    let mut own_branch = input("WP-162", "Update leftovers");
    own_branch.branch = "wp/162b-update-leftovers".into();
    let err = enqueue(&mut conn, &who, &own_branch, 2).unwrap_err();
    assert!(
        err.contains("not made for this package"),
        "queued a branch whose number is not this package's: {err}"
    );

    let mut longer = input("WP-9", "Nine");
    longer.branch = "wp/90".into();
    let err = enqueue(&mut conn, &who, &longer, 3).unwrap_err();
    assert!(err.contains("not made for this package"), "{err}");

    let mut shorter = input("WP-90", "Ninety");
    shorter.branch = "wp/9".into();
    let err = enqueue(&mut conn, &who, &shorter, 4).unwrap_err();
    assert!(err.contains("not made for this package"), "{err}");

    let mut numbered = input("WP-162", "Update leftovers");
    numbered.branch = "wp/162".into();
    let row = enqueue(&mut conn, &who, &numbered, 5).unwrap();
    assert_eq!(row.branch, "wp/162");

    let mut titled = input("WP-20", "Twenty");
    titled.branch = "wp/WP-20".into();
    let titled = enqueue(&mut conn, &who, &titled, 6).unwrap();
    assert_eq!(titled.branch, "wp/WP-20");

    let mut morning = input("WP-159", "Morning");
    morning.branch = "wp/159".into();
    let morning = enqueue(&mut conn, &who, &morning, 7).unwrap();
    assert_eq!(morning.branch, "wp/159");

    // Already open: a branch that is not this package's is still refused, and the row is left as it was.
    let mut again = input("WP-162", "Update leftovers");
    again.branch = "ash/notes".into();
    let err = enqueue(&mut conn, &who, &again, 8).unwrap_err();
    assert!(err.contains("not made for this package"), "{err}");
    assert_eq!(get(&conn, &who, &row.id).unwrap().branch, "wp/162");
}

#[test]
fn a_lettered_package_matches_the_id_without_its_wp_prefix() {
    assert!(branch_for_package("wp/153b-quarantine-rewrite", "WP-153b"));
    assert!(branch_for_package("wp/141d-follow-up", "WP-141d"));
    assert!(branch_for_package("wp/162b-update-leftovers", "WP-162b"));
    assert!(branch_for_package("WP/153B-quarantine-rewrite", "wp-153b"));
    assert!(branch_for_package("wp/a-notes", "WP-A"));
    assert!(branch_for_package("wp/WP-153b", "WP-153b"));
    assert!(branch_for_package("wp/162", "WP-162"));
    assert!(!branch_for_package("wp/153b-quarantine-rewrite", "WP-153"));
    assert!(!branch_for_package("wp/153-quarantine", "WP-153b"));
    assert!(!branch_for_package("wp/162b-update-leftovers", "WP-162"));
    assert!(!branch_for_package("wp/ab-notes", "WP-A"));
    assert!(!branch_for_package("wp/9", "WP-90"));
    assert!(!branch_for_package("wp/90", "WP-9"));
    assert!(!branch_for_package("wp/90-notes", "WP-9"));
    assert!(!branch_for_package("wp/9-notes", "WP-90"));
    assert!(!branch_for_package("wp/0162", "WP-162"));
    assert!(!branch_for_package("feature/153b", "WP-153b"));
    assert!(!branch_for_package("wp/", "WP-153b"));
    assert!(!branch_for_package("", "WP-153b"));
    assert!(!branch_for_package("wp/153b", ""));
    assert!(!branch_for_package("wp/153b", "WP-"));

    let mut conn = memory();
    let who = mate();
    let mut lettered = input("WP-153b", "Quarantine");
    lettered.branch = "wp/153b-quarantine-rewrite".into();
    let row = enqueue(&mut conn, &who, &lettered, 1).unwrap();
    assert_eq!(row.branch, "wp/153b-quarantine-rewrite");
}

/// A lettered id is a word as well as a number, so a short one would match any branch that happens to use it
/// (`WP-A` and `wp/fix-a-bug`). For a lettered id only the first part after `wp/` counts. A numbered id keeps
/// matching any part, as it did before lettered ids were read.
#[test]
fn a_lettered_package_matches_only_the_first_part_after_wp() {
    assert!(!branch_for_package("wp/fix-a-bug", "WP-A"));
    assert!(!branch_for_package("wp/notes-for-153b", "WP-153b"));
    assert!(!branch_for_package("wp/hub/153b-quarantine", "WP-153b"));
    assert!(branch_for_package("wp/a-notes", "WP-A"));
    assert!(branch_for_package("wp/153b-quarantine-rewrite", "WP-153b"));
    assert!(branch_for_package("WP/153B-quarantine-rewrite", "wp-153b"));
    assert!(branch_for_package("wp/hub/WP-153b", "WP-153b"));
    assert!(branch_for_package("wp/fix-162", "WP-162"));
    assert!(branch_for_package("wp/162", "WP-162"));
}

#[test]
fn a_repeated_enqueue_does_not_overwrite() {
    let mut conn = memory();
    let who = mate();
    let first = enqueue(&mut conn, &who, &input("WP-1", "First title"), 1).unwrap();
    let mut again = input("WP-1", "Second title");
    again.priority = Some(9);
    again.notes = Some("nope".into());
    let second = enqueue(&mut conn, &who, &again, 2).unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(second.title, "First title");
    assert_eq!(second.priority, 0);
    assert_eq!(second.notes, "");
    assert_eq!(second.version, 1);
    assert_eq!(list(&conn, &who).unwrap().len(), 1);
}

#[test]
fn a_failed_package_can_be_queued_again() {
    let mut conn = memory();
    let who = mate();
    let row = enqueue(&mut conn, &who, &input("WP-2", "Try"), 1).unwrap();
    let claimed = claim(&mut conn, &who, &row.id, row.version, 2).unwrap();
    let failed = finish(&mut conn, &who, &row.id, claimed.version, "failed", 3).unwrap();
    assert_eq!(failed.finished_at, Some(3));
    let next = enqueue(&mut conn, &who, &input("WP-2", "Try again"), 4).unwrap();
    assert_ne!(next.id, row.id);
    let blocked = set_status(&mut conn, &who, &row.id, failed.version, "queued", 5).unwrap_err();
    assert!(blocked.contains("already on the programme"));
    assert_eq!(get(&conn, &who, &row.id).unwrap().status, "failed");
    conn.execute("DELETE FROM programme_packages WHERE id = ?1", [&next.id])
        .unwrap();
    let retry = set_status(&mut conn, &who, &row.id, failed.version, "queued", 6).unwrap();
    assert_eq!(retry.status, "queued");
    assert_eq!(retry.finished_at, None);
    assert_eq!(retry.claimed_at, None);
}

#[test]
fn security_park_blocks_a_claim_until_the_person_clears_it() {
    let mut conn = memory();
    let mut spec = input("WP-3", "Careful");
    spec.security_park = true;
    let row = enqueue(&mut conn, &mate(), &spec, 1).unwrap();
    assert!(row.security_park);
    let blocked = claim(&mut conn, &mate(), &row.id, row.version, 2).unwrap_err();
    assert!(blocked.contains("security check"));
    assert_eq!(get(&conn, &mate(), &row.id).unwrap().status, "queued");
    let cleared = clear_park(&mut conn, &person(), &row.id, row.version, 3).unwrap();
    assert!(!cleared.security_park);
    assert_eq!(cleared.status, "queued");
    let claimed = claim(&mut conn, &mate(), &row.id, cleared.version, 4).unwrap();
    assert_eq!(claimed.status, "building");
}

#[test]
fn parking_again_keeps_the_security_flag() {
    let mut conn = memory();
    let row = enqueue(&mut conn, &mate(), &input("WP-4", "Hold"), 1).unwrap();
    let parked = park(&mut conn, &mate(), &row.id, row.version, "Scan", true, 2).unwrap();
    assert!(parked.security_park);
    let same = park(
        &mut conn,
        &mate(),
        &row.id,
        parked.version,
        "Scan",
        false,
        3,
    )
    .unwrap();
    assert_eq!(same.version, parked.version);
    assert!(same.security_park);
    let reason = park(
        &mut conn,
        &mate(),
        &row.id,
        same.version,
        "Scan again",
        false,
        4,
    )
    .unwrap();
    assert_eq!(reason.park_reason.as_deref(), Some("Scan again"));
    assert!(reason.security_park);
    assert_eq!(reason.status, "parked");
}

#[test]
fn a_second_window_cannot_claim_what_the_first_took() {
    let temp = TempDb::new();
    let path = temp.path();
    let mut first = open_db(&path);
    let mut second = open_db(&path);
    let row = enqueue(&mut first, &mate(), &input("WP-5", "Race"), 1).unwrap();
    let won = claim(&mut first, &mate(), &row.id, row.version, 2).unwrap();
    let lost = claim(&mut second, &mate(), &row.id, row.version, 3).unwrap_err();
    assert!(lost.contains("Read it again"));
    let seen = get(&second, &mate(), &row.id).unwrap();
    assert_eq!(seen.status, "building");
    assert_eq!(seen.version, won.version);
    assert_eq!(seen.claimed_at, Some(2));
}

#[test]
fn a_claim_is_still_there_after_the_file_reopens() {
    let temp = TempDb::new();
    let path = temp.path();
    let id = {
        let mut conn = open_db(&path);
        let row = enqueue(&mut conn, &mate(), &input("WP-6", "Survive"), 1).unwrap();
        let claimed = claim(&mut conn, &mate(), &row.id, row.version, 2).unwrap();
        let parked = park(
            &mut conn,
            &mate(),
            &row.id,
            claimed.version,
            "Wait",
            false,
            3,
        )
        .unwrap();
        parked.id
    };
    let conn = open_db(&path);
    let row = get(&conn, &mate(), &id).unwrap();
    assert_eq!(row.status, "parked");
    assert_eq!(row.park_reason.as_deref(), Some("Wait"));
    assert_eq!(row.claimed_at, Some(2));
}

#[test]
fn a_removed_row_is_not_claimed() {
    let mut conn = memory();
    let row = enqueue(&mut conn, &mate(), &input("WP-7", "Gone"), 1).unwrap();
    conn.execute("DELETE FROM programme_packages WHERE id = ?1", [&row.id])
        .unwrap();
    let err = claim(&mut conn, &mate(), &row.id, row.version, 2).unwrap_err();
    assert!(err.contains("No package"));
}

#[test]
fn another_project_cannot_see_or_claim_the_row() {
    let mut conn = memory();
    let row = enqueue(&mut conn, &mate(), &input("WP-8", "Mine"), 1).unwrap();
    let other = actor("first-mate", "notes");
    assert!(list(&conn, &other).unwrap().is_empty());
    assert!(claim(&mut conn, &other, &row.id, row.version, 2)
        .unwrap_err()
        .contains("No package"));
    assert_eq!(get(&conn, &mate(), &row.id).unwrap().status, "queued");
}

#[test]
fn workers_are_refused_and_write_nothing() {
    let mut conn = memory();
    let err = enqueue(&mut conn, &worker(), &input("WP-9", "No"), 1).unwrap_err();
    assert_eq!(err, WORKER_REASON);
    assert!(list(&conn, &worker()).unwrap_err() == WORKER_REASON);
    assert!(list(&conn, &mate()).unwrap().is_empty());
    let row = enqueue(&mut conn, &mate(), &input("WP-9", "Yes"), 2).unwrap();
    assert!(park(
        &mut conn,
        &worker(),
        &row.id,
        row.version,
        "because",
        false,
        3
    )
    .is_err());
    assert_eq!(get(&conn, &mate(), &row.id).unwrap().status, "queued");
}

#[test]
fn bad_paths_notes_and_duplicates_are_refused() {
    let mut conn = memory();
    let who = mate();
    let mut missing = input("WP-10", "Ok");
    missing.brief_path = "  ".into();
    assert!(enqueue(&mut conn, &who, &missing, 1)
        .unwrap_err()
        .contains("required"));

    for path in [
        "../secret.md",
        "docs/../secret.md",
        "/etc/passwd",
        "C:/briefs/one.md",
        "docs//two.md",
        "docs/./two.md",
    ] {
        let mut bad = input("WP-10", "Ok");
        bad.brief_path = path.into();
        assert!(enqueue(&mut conn, &who, &bad, 1).is_err(), "{path}");
    }

    let mut spaced = input("WP-10", "Ok");
    spaced.brief_path = "docs/my briefs/笔记.md".into();
    let row = enqueue(&mut conn, &who, &spaced, 1).unwrap();
    assert_eq!(row.brief_path, "docs/my briefs/笔记.md");

    let mut crlf = input("WP-11", "Notes");
    crlf.notes = Some("one\r\ntwo".into());
    let noted = enqueue(&mut conn, &who, &crlf, 2).unwrap();
    assert_eq!(noted.notes, "one\ntwo");

    let mut huge = input("WP-12", "Huge");
    huge.notes = Some("n".repeat(NOTE_MAX + 1));
    assert!(enqueue(&mut conn, &who, &huge, 3)
        .unwrap_err()
        .contains("under"));
    huge.notes = Some("n".repeat(NOTE_MAX));
    assert!(enqueue(&mut conn, &who, &huge, 4).is_ok());

    let mut priority = input("WP-13", "Rank");
    priority.priority = Some(1001);
    assert!(enqueue(&mut conn, &who, &priority, 5).is_err());
    priority.priority = Some(-1000);
    assert!(enqueue(&mut conn, &who, &priority, 6).is_ok());

    let queued = enqueue(&mut conn, &who, &input("WP-14", "Empty reason"), 7).unwrap();
    assert!(park(&mut conn, &who, &queued.id, queued.version, "  ", false, 8).is_err());
    assert_eq!(get(&conn, &who, &queued.id).unwrap().status, "queued");
    assert!(list(&conn, &who).unwrap().len() >= 4);
}

#[test]
fn the_board_fills_and_orders_by_priority() {
    let mut conn = memory();
    let who = mate();
    let mut low = input("WP-A", "Low");
    low.priority = Some(0);
    let mut high = input("WP-B", "High");
    high.priority = Some(5);
    enqueue(&mut conn, &who, &low, 1).unwrap();
    enqueue(&mut conn, &who, &high, 2).unwrap();
    let listed = list(&conn, &who).unwrap();
    assert_eq!(listed[0].wp, "WP-B");
    assert_eq!(listed[1].wp, "WP-A");

    let first = enqueue_limited(&mut conn, &who, &input("WP-C", "One"), 3, 2).unwrap_err();
    assert!(first.contains("full"));
    let retry = enqueue_limited(&mut conn, &who, &low, 4, 2).unwrap();
    assert_eq!(retry.wp, "WP-A");
    assert_eq!(list(&conn, &who).unwrap().len(), 2);
}

#[test]
fn finish_from_the_queue_and_a_merged_row_do_not_move() {
    let mut conn = memory();
    let who = mate();
    let row = enqueue(&mut conn, &who, &input("WP-15", "Early"), 1).unwrap();
    assert!(finish(&mut conn, &who, &row.id, row.version, "merged", 2).is_err());
    assert!(finish(&mut conn, &who, &row.id, row.version, "queued", 2).is_err());
    assert_eq!(get(&conn, &who, &row.id).unwrap().version, 1);
    let claimed = claim(&mut conn, &who, &row.id, row.version, 3).unwrap();
    let merged = finish(&mut conn, &who, &row.id, claimed.version, "merged", 4).unwrap();
    assert_eq!(merged.finished_at, Some(4));
    assert!(park(
        &mut conn,
        &who,
        &row.id,
        merged.version,
        "too late",
        false,
        5
    )
    .is_err());
    assert!(set_status(&mut conn, &who, &row.id, merged.version, "queued", 6).is_err());
    assert_eq!(get(&conn, &who, &row.id).unwrap().status, "merged");
}

#[test]
fn an_unknown_caller_is_not_the_first_mate() {
    let mut conn = memory();
    let err = enqueue(&mut conn, &actor("guest", "crew"), &input("WP-16", "No"), 1).unwrap_err();
    assert!(err.contains("Only the first mate"));
    assert!(!err.contains("worker"));
}

fn merge(conn: &mut Connection, who: &Actor, id: &str, now: i64) {
    let row = get(conn, who, id).unwrap();
    let claimed = claim(conn, who, id, row.version, now).unwrap();
    finish(conn, who, id, claimed.version, "merged", now + 1).unwrap();
}

#[test]
fn a_merged_row_does_not_use_up_the_cap() {
    let mut conn = memory();
    let who = mate();
    let done = enqueue_limited(&mut conn, &who, &input("WP-M1", "Done"), 1, 2).unwrap();
    merge(&mut conn, &who, &done.id, 2);
    enqueue_limited(&mut conn, &who, &input("WP-M2", "Open one"), 5, 2).unwrap();
    enqueue_limited(&mut conn, &who, &input("WP-M3", "Open two"), 6, 2).unwrap();
    let full = enqueue_limited(&mut conn, &who, &input("WP-M4", "Open three"), 7, 2).unwrap_err();
    assert!(full.contains("full"));
    assert_eq!(list_with(&conn, &who, true, LIST_MAX).unwrap().len(), 3);
}

#[test]
fn the_list_leaves_merged_rows_out_unless_asked_and_is_capped() {
    let mut conn = memory();
    let who = mate();
    let done = enqueue(&mut conn, &who, &input("WP-L1", "Done"), 1).unwrap();
    merge(&mut conn, &who, &done.id, 2);
    enqueue(&mut conn, &who, &input("WP-L2", "Open"), 5).unwrap();
    enqueue(&mut conn, &who, &input("WP-L3", "Open too"), 6).unwrap();
    let open = list(&conn, &who).unwrap();
    assert_eq!(open.len(), 2);
    assert!(open.iter().all(|row| row.status != "merged"));
    assert_eq!(list_with(&conn, &who, true, LIST_MAX).unwrap().len(), 3);
    assert_eq!(list_with(&conn, &who, false, 1).unwrap().len(), 1);
    assert_eq!(list_with(&conn, &who, true, 2).unwrap().len(), 2);
}

#[test]
fn a_parked_row_cannot_be_sidestepped_by_case() {
    let mut conn = memory();
    let who = mate();
    let row = enqueue(&mut conn, &who, &input("WP-9", "Parked one"), 1).unwrap();
    park(
        &mut conn,
        &who,
        &row.id,
        row.version,
        "Needs a look",
        false,
        2,
    )
    .unwrap();
    let again = enqueue(&mut conn, &who, &input("wp-9", "Same work"), 3).unwrap();
    assert_eq!(again.id, row.id);
    assert_eq!(again.status, "parked");
    assert_eq!(list(&conn, &who).unwrap().len(), 1);
}

#[test]
fn an_open_branch_or_brief_cannot_be_queued_twice() {
    let mut conn = memory();
    let who = mate();
    enqueue(&mut conn, &who, &input("WP-20", "First"), 1).unwrap();

    let mut same_branch = input("WP-21", "Second");
    same_branch.branch = "wp/WP-20".into();
    assert!(enqueue(&mut conn, &who, &same_branch, 2).is_err());

    let mut same_brief = input("WP-22", "Third");
    same_brief.brief_path = "docs/briefs/WP-20.md".into();
    assert!(enqueue(&mut conn, &who, &same_brief, 3).is_err());

    let mut same_brief_case = input("WP-23", "Fourth");
    same_brief_case.brief_path = "Docs/Briefs/wp-20.md".into();
    assert!(enqueue(&mut conn, &who, &same_brief_case, 4).is_err());

    let done = list(&conn, &who).unwrap()[0].clone();
    merge(&mut conn, &who, &done.id, 5);
    let after_merge = enqueue(&mut conn, &who, &same_branch, 8).unwrap();
    assert_eq!(after_merge.wp, "WP-21");
}

#[test]
fn errors_name_pr_open_as_the_status_an_agent_sends() {
    let mut conn = memory();
    let who = mate();
    let row = enqueue(&mut conn, &who, &input("WP-30", "Early"), 1).unwrap();
    let early = finish(&mut conn, &who, &row.id, row.version, "pr_open", 2).unwrap_err();
    assert!(early.contains("pr_open"), "{early}");
    assert!(!early.contains("pull request"), "{early}");
    let bad = set_status(
        &mut conn,
        &who,
        &row.id,
        row.version,
        "pull request open",
        3,
    )
    .unwrap_err();
    assert!(bad.contains("pr_open"), "{bad}");
    assert!(!bad.contains("pull request"), "{bad}");
}
