//! WP-77, with a fake `gh`. Nothing here starts a process or reads a real account.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::gh::{self, IssuesGh};
use super::rules;
use super::sync::{self, Assignee, SettingWrite};
use crate::session_store::SessionStore;
use crate::tasks::store::{self, Actor, SyncRequest, UpdateInput};

const PROJECT: &str = "C:\\work\\café ..\\proj";
const OTHER: &str = "/work/other";
const REPO: &str = "acme/web";
const MATE: &str = "mate-1";

struct Fake {
    issues: Vec<Value>,
    prs: Vec<Value>,
    views: BTreeMap<i64, Value>,
    fail_lists: bool,
    calls: Vec<String>,
    poke: Option<Box<dyn FnMut()>>,
}

impl Fake {
    fn new(issues: Vec<Value>, prs: Vec<Value>) -> Self {
        Self {
            issues,
            prs,
            views: BTreeMap::new(),
            fail_lists: false,
            calls: Vec::new(),
            poke: None,
        }
    }
}

impl IssuesGh for Fake {
    fn list(&mut self, kind: &str, repo: &str, search: &str) -> Result<String, String> {
        self.calls.push(format!("list {kind} {repo} {search}"));
        if let Some(mut poke) = self.poke.take() {
            poke();
        }
        if self.fail_lists {
            return Err("GitHub didn't answer in time.".into());
        }
        let rows = if kind == "pr" {
            &self.prs
        } else {
            &self.issues
        };
        Ok(Value::Array(rows.clone()).to_string())
    }

    fn view_pr(&mut self, repo: &str, number: i64) -> Result<String, String> {
        self.calls.push(format!("view {repo} {number}"));
        self.views
            .get(&number)
            .map(|row| row.to_string())
            .ok_or_else(|| "missing".into())
    }

    fn view_repo(&mut self, cwd: &str) -> Result<String, String> {
        self.calls.push(format!("repo {cwd}"));
        Err("no repo".into())
    }
}

fn gh_issue(number: i64, title: &str, body: &str, state: &str, labels: &[&str]) -> Value {
    json!({
        "number": number,
        "title": title,
        "body": body,
        "state": state,
        "labels": labels.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>(),
    })
}

fn gh_pr(
    number: i64,
    title: &str,
    body: &str,
    state: &str,
    merged_at: Option<&str>,
    labels: &[&str],
) -> Value {
    json!({
        "number": number,
        "title": title,
        "body": body,
        "state": state,
        "mergedAt": merged_at,
        "labels": labels.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>(),
    })
}

fn open() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn enable(store: &SessionStore, project: &str, label: &str, assignee: Option<&str>) {
    let mut conn = store.lock_conn().unwrap();
    let saved = sync::set_setting(
        &mut conn,
        project,
        SettingWrite {
            enabled: true,
            label: Some(label),
            repo: Some(REPO),
            assignee,
            expected_version: 0,
        },
        &mut Fake::new(vec![], vec![]),
    )
    .unwrap();
    assert!(!saved.stale);
    assert!(saved.enabled);
    assert_eq!(saved.repo.as_deref(), Some(REPO));
}

fn poll_at(
    store: &SessionStore,
    fake: &mut Fake,
    now: i64,
    assignees: &[Assignee],
) -> sync::Report {
    sync::poll(store, fake, now, assignees).unwrap()
}

fn person() -> Actor {
    Actor {
        id: "person".into(),
        project: PROJECT.into(),
        kind: "person".into(),
    }
}

fn ids(store: &SessionStore) -> Vec<String> {
    let conn = store.lock_conn().unwrap();
    let Ok(mut stmt) = conn.prepare("SELECT id FROM tasks ORDER BY number") else {
        return Vec::new();
    };
    stmt.query_map([], |row| row.get(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
}

fn task(store: &SessionStore, id: &str) -> store::Task {
    let conn = store.lock_conn().unwrap();
    store::get(&conn, &person(), id).unwrap()
}

fn only(store: &SessionStore) -> store::Task {
    let found = ids(store);
    assert_eq!(found.len(), 1, "expected one task, got {}", found.len());
    task(store, &found[0])
}

fn titled(store: &SessionStore, title: &str) -> store::Task {
    let conn = store.lock_conn().unwrap();
    let id: String = conn
        .query_row("SELECT id FROM tasks WHERE title = ?1", [title], |row| {
            row.get(0)
        })
        .unwrap();
    drop(conn);
    task(store, &id)
}

fn wakes(store: &SessionStore) -> Vec<String> {
    let conn = store.lock_conn().unwrap();
    let Ok(mut stmt) = conn.prepare("SELECT text FROM firstmate_wakes ORDER BY text") else {
        return Vec::new();
    };
    stmt.query_map([], |row| row.get(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
}

fn next_at(store: &SessionStore, project: &str) -> Option<i64> {
    let conn = store.lock_conn().unwrap();
    conn.query_row(
        "SELECT next_poll_at FROM github_issue_settings WHERE project_id = ?1",
        [project],
        |row| row.get(0),
    )
    .unwrap()
}

fn enabled_flag(store: &SessionStore) -> i64 {
    let conn = store.lock_conn().unwrap();
    conn.query_row(
        "SELECT enabled FROM github_issue_settings WHERE project_id = ?1",
        [PROJECT],
        |row| row.get(0),
    )
    .unwrap()
}

fn paused(store: &SessionStore, number: i64) -> i64 {
    let conn = store.lock_conn().unwrap();
    conn.query_row(
        "SELECT sync_paused FROM github_issue_links WHERE repository = ?1 AND issue_number = ?2",
        rusqlite::params![REPO, number],
        |row| row.get(0),
    )
    .unwrap()
}

fn mate() -> Vec<Assignee> {
    vec![Assignee {
        project: PROJECT.into(),
        assignee: MATE.into(),
    }]
}

#[test]
fn off_until_the_person_turns_it_on() {
    let store = open();
    let mut fake = Fake::new(vec![gh_issue(1, "Nope", "", "OPEN", &["hivra"])], vec![]);
    let report = poll_at(&store, &mut fake, 0, &mate());
    assert!(fake.calls.is_empty());
    assert_eq!(report.polled, 0);
    assert!(ids(&store).is_empty());
    let conn = store.lock_conn().unwrap();
    let blank = sync::get_setting(&conn, PROJECT).unwrap();
    assert!(!blank.enabled);
    assert_eq!(blank.label, "hivra");
    assert_eq!(blank.version, 0);
}

#[test]
fn a_label_creates_one_task_and_one_brief_and_a_repeat_changes_nothing() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(
            7,
            "Fix the door",
            "It sticks.",
            "OPEN",
            &["hivra"],
        )],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    assert_eq!(created.source, "github");
    assert_eq!(created.status, "Backlog");
    assert_eq!(created.title, "Fix the door");
    assert_eq!(created.description, "It sticks.");
    assert_eq!(created.assignee.as_deref(), Some(MATE));
    assert_eq!(created.project_id, PROJECT);
    assert_eq!(
        created.github_url.as_deref(),
        Some("https://github.com/acme/web/issues/7")
    );
    assert!(!created.github_paused);
    assert_eq!(wakes(&store), vec!["pick up task #1".to_string()]);
    assert_eq!(created.version, 1);
    let calls = fake.calls.len();
    poll_at(&store, &mut fake, 1_000, &[]);
    assert_eq!(
        fake.calls.len(),
        calls,
        "a poll before the gap must not read"
    );
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    let again = only(&store);
    assert_eq!(again.id, created.id);
    assert_eq!(again.version, created.version);
    assert_eq!(wakes(&store).len(), 1);
    assert_eq!(ids(&store).len(), 1);
}

#[test]
fn an_edit_keeps_the_status_a_person_set() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(
            7,
            "Fix the door",
            "It sticks.",
            "OPEN",
            &["hivra"],
        )],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    let mut conn = store.lock_conn().unwrap();
    store::update(
        &mut conn,
        &person(),
        &UpdateInput {
            id: created.id.clone(),
            version: Some(created.version),
            status: Some("In progress".into()),
            ..Default::default()
        },
        50,
    )
    .unwrap();
    drop(conn);
    fake.issues = vec![gh_issue(
        7,
        "Fix the door properly",
        "It sticks.",
        "OPEN",
        &["hivra"],
    )];
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    let edited = only(&store);
    assert_eq!(edited.title, "Fix the door properly");
    assert_eq!(edited.status, "In progress");
    assert_eq!(edited.id, created.id);
}

#[test]
fn closing_and_reopening_an_issue_follows_github() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(7, "Fix the door", "", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    fake.issues = vec![gh_issue(7, "Fix the door", "", "CLOSED", &["hivra"])];
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    assert_eq!(only(&store).status, "Done");
    fake.issues = vec![gh_issue(7, "Fix the door", "", "OPEN", &["hivra"])];
    let at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    assert_eq!(only(&store).status, "Backlog");
}

#[test]
fn a_merged_pull_request_completes_and_a_closed_one_is_cancelled() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![],
        vec![
            gh_pr(
                4,
                "Land it",
                "body",
                "CLOSED",
                Some("2020-01-01T00:00:00Z"),
                &["hivra"],
            ),
            gh_pr(5, "Drop it", "body", "CLOSED", None, &["hivra"]),
        ],
    );
    poll_at(&store, &mut fake, 0, &[]);
    assert_eq!(titled(&store, "Land it").status, "Done");
    assert_eq!(
        titled(&store, "Land it").github_url.as_deref(),
        Some("https://github.com/acme/web/pull/4")
    );
    assert_eq!(titled(&store, "Drop it").status, "Cancelled");
    assert_eq!(ids(&store).len(), 2);
}

#[test]
fn removing_the_label_pauses_and_adding_it_resumes_the_same_task() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(7, "Fix the door", "", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    fake.issues.clear();
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    let paused_task = task(&store, &created.id);
    assert!(paused_task.github_paused);
    assert_eq!(paused_task.title, "Fix the door");
    assert!(paused_task.trashed_at.is_none());
    assert_eq!(paused(&store, 7), 1);
    fake.issues = vec![gh_issue(7, "Fix the door again", "", "OPEN", &["hivra"])];
    let at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    let resumed = only(&store);
    assert_eq!(resumed.id, created.id);
    assert!(!resumed.github_paused);
    assert_eq!(resumed.title, "Fix the door again");
}

#[test]
fn a_trashed_task_comes_back_only_while_the_label_is_on() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(7, "Fix the door", "", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    let mut conn = store.lock_conn().unwrap();
    store::update(
        &mut conn,
        &person(),
        &UpdateInput {
            id: created.id.clone(),
            version: Some(created.version),
            trash: true,
            ..Default::default()
        },
        20,
    )
    .unwrap();
    drop(conn);
    assert!(task(&store, &created.id).trashed_at.is_some());
    fake.issues.clear();
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    assert!(task(&store, &created.id).trashed_at.is_some());
    assert_eq!(paused(&store, 7), 1);
    fake.issues = vec![gh_issue(7, "Back", "now", "CLOSED", &["hivra"])];
    let at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    let restored = task(&store, &created.id);
    assert!(restored.trashed_at.is_none());
    assert_eq!(restored.title, "Back");
    assert_eq!(restored.status, "Done");
    assert!(!restored.github_paused);
}

#[test]
fn a_restored_task_whose_parent_is_still_trashed_comes_back_at_the_top() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(vec![gh_issue(7, "Child", "", "OPEN", &["hivra"])], vec![]);
    poll_at(&store, &mut fake, 0, &[]);
    let child = only(&store);
    let mut conn = store.lock_conn().unwrap();
    let parent = store::create(
        &mut conn,
        &person(),
        &store::CreateInput {
            title: "Parent".into(),
            ..Default::default()
        },
        10,
    )
    .unwrap();
    conn.execute(
        "UPDATE tasks SET parent_id = ?1 WHERE id = ?2",
        rusqlite::params![parent.task.id, child.id],
    )
    .unwrap();
    let parent = store::get(&conn, &person(), &parent.task.id).unwrap();
    store::update(
        &mut conn,
        &person(),
        &UpdateInput {
            id: parent.id.clone(),
            version: Some(parent.version),
            trash: true,
            ..Default::default()
        },
        20,
    )
    .unwrap();
    drop(conn);
    let at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    let restored = task(&store, &child.id);
    assert!(restored.trashed_at.is_none());
    assert_eq!(restored.parent_id, None);
    assert_eq!(restored.title, "Child");
}

#[test]
fn an_unchanged_board_waits_longer_and_a_change_resets_the_wait() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(7, "Fix the door", "", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    assert_eq!(next_at(&store, PROJECT), Some(rules::MIN_POLL_MS));
    let calls = fake.calls.len();
    poll_at(&store, &mut fake, rules::MIN_POLL_MS - 1, &[]);
    assert_eq!(fake.calls.len(), calls);
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    assert_eq!(
        next_at(&store, PROJECT),
        Some(rules::MIN_POLL_MS + rules::gap_after(1))
    );
    let mut at = rules::MIN_POLL_MS;
    for _ in 0..4 {
        at = next_at(&store, PROJECT).unwrap();
        poll_at(&store, &mut fake, at, &[]);
    }
    let gap = next_at(&store, PROJECT).unwrap() - at;
    assert_eq!(gap, rules::MAX_POLL_MS);
    at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    assert_eq!(next_at(&store, PROJECT).unwrap() - at, rules::MAX_POLL_MS);
    fake.issues = vec![gh_issue(7, "Changed", "", "OPEN", &["hivra"])];
    at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    assert_eq!(next_at(&store, PROJECT), Some(at + rules::MIN_POLL_MS));
    assert_eq!(only(&store).title, "Changed");
}

#[test]
fn a_timeout_does_not_turn_the_setting_off_or_pause_a_link() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(3, "Keep", "body", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    fake.fail_lists = true;
    fake.issues.clear();
    let report = poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    assert_eq!(report.failed, 1);
    assert_eq!(enabled_flag(&store), 1);
    assert!(!task(&store, &created.id).github_paused);
    assert_eq!(task(&store, &created.id).title, "Keep");
    assert_eq!(next_at(&store, PROJECT), Some(rules::MIN_POLL_MS * 2));
    fake.fail_lists = false;
    fake.issues = vec![gh_issue(3, "Keep", "body", "OPEN", &["hivra"])];
    let again = poll_at(&store, &mut fake, rules::MIN_POLL_MS * 2, &[]);
    assert_eq!(again.polled, 1);
    assert_eq!(again.failed, 0);
    assert_eq!(ids(&store).len(), 1);
}

#[test]
fn an_empty_or_over_long_title_is_skipped_and_does_not_pause() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let long = "x".repeat(store::TITLE_MAX + 1);
    let mut fake = Fake::new(
        vec![
            gh_issue(1, "", "nope", "OPEN", &["hivra"]),
            gh_issue(2, &long, "nope", "OPEN", &["hivra"]),
            gh_issue(3, "Kept", "yes", "OPEN", &["hivra"]),
        ],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    assert_eq!(ids(&store).len(), 1);
    assert_eq!(only(&store).title, "Kept");
    // A later bad read of an existing item must not look like the label left.
    fake.issues = vec![
        gh_issue(3, &long, "yes", "OPEN", &["hivra"]),
        gh_issue(4, "Also", "", "OPEN", &["hivra"]),
    ];
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    assert_eq!(titled(&store, "Kept").title, "Kept");
    assert!(!titled(&store, "Kept").github_paused);
    assert_eq!(titled(&store, "Also").title, "Also");
}

#[test]
fn two_project_labels_on_one_item_do_not_move_it() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    enable(&store, OTHER, "other", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(7, "Both", "", "OPEN", &["hivra", "other"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    assert!(ids(&store).is_empty());
    fake.issues = vec![gh_issue(7, "Only ours", "", "OPEN", &["hivra"])];
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    let created = only(&store);
    assert_eq!(created.project_id, PROJECT);
    fake.issues = vec![gh_issue(
        7,
        "Do not rename",
        "",
        "OPEN",
        &["hivra", "other"],
    )];
    let at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    let stayed = task(&store, &created.id);
    assert_eq!(stayed.title, "Only ours");
    assert!(!stayed.github_paused);
    assert_eq!(ids(&store).len(), 1);
}

#[test]
fn a_kind_or_project_mismatch_is_left_where_it_is() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(7, "Fix the door", "", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "UPDATE github_issue_links SET kind = 'pull_request' WHERE issue_number = 7",
        [],
    )
    .unwrap();
    drop(conn);
    fake.issues = vec![gh_issue(7, "Renamed", "", "OPEN", &["hivra"])];
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    assert_eq!(task(&store, &created.id).title, "Fix the door");
    assert!(!task(&store, &created.id).github_paused);
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "UPDATE github_issue_links SET kind = 'issue' WHERE issue_number = 7",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE tasks SET project_id = 'elsewhere' WHERE id = ?1",
        [&created.id],
    )
    .unwrap();
    drop(conn);
    let at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    let conn = store.lock_conn().unwrap();
    let title: String = conn
        .query_row(
            "SELECT title FROM tasks WHERE id = ?1",
            [&created.id],
            |row| row.get(0),
        )
        .unwrap();
    let paused_flag: i64 = conn
        .query_row(
            "SELECT sync_paused FROM github_issue_links WHERE issue_number = 7",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(title, "Fix the door");
    assert_eq!(paused_flag, 0);
}

#[test]
fn github_owns_the_title_and_description_but_not_the_status() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(
            7,
            "Fix the door",
            "It sticks.",
            "OPEN",
            &["hivra"],
        )],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    let mut conn = store.lock_conn().unwrap();
    let denied = store::update(
        &mut conn,
        &person(),
        &UpdateInput {
            id: created.id.clone(),
            version: Some(created.version),
            title: Some("Mine".into()),
            ..Default::default()
        },
        30,
    );
    assert_eq!(
        denied.unwrap_err(),
        "GitHub controls this task's title and description."
    );
    let denied = store::update(
        &mut conn,
        &Actor {
            id: "agent-1".into(),
            project: PROJECT.into(),
            kind: "agent".into(),
        },
        &UpdateInput {
            id: created.id.clone(),
            version: Some(created.version),
            description: Some("nope".into()),
            ..Default::default()
        },
        31,
    );
    assert!(denied.unwrap_err().contains("GitHub controls"));
    let written = store::update(
        &mut conn,
        &person(),
        &UpdateInput {
            id: created.id.clone(),
            version: Some(created.version),
            status: Some("In progress".into()),
            comment: Some("Still ours.".into()),
            ..Default::default()
        },
        32,
    )
    .unwrap();
    assert!(!written.stale);
    assert_eq!(written.task.status, "In progress");
    assert_eq!(written.task.title, "Fix the door");
    assert_eq!(written.task.comments.len(), 1);
}

#[test]
fn the_crews_pull_request_completes_the_issue_when_it_merges() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(8, "The issue", "", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let issue = only(&store);
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "UPDATE tasks SET delegation_id = 'del-1' WHERE id = ?1",
        [&issue.id],
    )
    .unwrap();
    sync::link_opened_pr(
        &conn,
        "del-1",
        REPO,
        4,
        Some("https://github.com/acme/web/pull/4"),
        10,
    )
    .unwrap();
    drop(conn);
    fake.views.insert(
        4,
        json!({"state": "CLOSED", "mergedAt": null, "title": "Crew", "url": "https://github.com/acme/web/pull/4"}),
    );
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    assert_ne!(task(&store, &issue.id).status, "Cancelled");
    assert_eq!(task(&store, &issue.id).status, "Backlog");
    fake.views.insert(
        4,
        json!({"state": "CLOSED", "mergedAt": "2020-01-01T00:00:00Z", "title": "Crew", "url": "https://github.com/acme/web/pull/4"}),
    );
    let at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    let done = task(&store, &issue.id);
    assert_eq!(done.status, "Done");
    assert_eq!(done.github_pulls.len(), 1);
    assert_eq!(done.github_pulls[0].state, "merged");
    // A labelled pull request with the same number gets its own task and must not drop this link.
    fake.prs = vec![gh_pr(
        4,
        "The PR itself",
        "",
        "CLOSED",
        Some("2020-01-01T00:00:00Z"),
        &["hivra"],
    )];
    let at = next_at(&store, PROJECT).unwrap();
    poll_at(&store, &mut fake, at, &[]);
    assert_eq!(ids(&store).len(), 2);
    let issue = task(&store, &issue.id);
    assert_eq!(issue.github_pulls.len(), 1);
    assert_eq!(issue.status, "Done");
    let pr = titled(&store, "The PR itself");
    assert_eq!(
        pr.github_url.as_deref(),
        Some("https://github.com/acme/web/pull/4")
    );
    assert!(pr.github_pulls.is_empty());
}

#[test]
fn a_running_delegation_cannot_reopen_a_task_github_already_closed() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(7, "Fix the door", "", "CLOSED", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    assert_eq!(created.status, "Done");
    let conn = store.lock_conn().unwrap();
    assert!(sync::terminal_hold(&conn, &created.id).unwrap());
    store::sync_delegation(
        &conn,
        &SyncRequest {
            delegation_id: "del-9".into(),
            parent_delegation_id: None,
            project: Some(PROJECT.into()),
            title: Some("Fix the door".into()),
            brief: None,
            state: "running".into(),
            follow: None,
            gate: None,
            assignee: MATE.into(),
            created_by: "person".into(),
            updated_at: 40,
            task_id: Some(created.id.clone()),
        },
    )
    .unwrap();
    drop(conn);
    assert_eq!(task(&store, &created.id).status, "Done");
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "UPDATE github_issue_links SET sync_paused = 1 WHERE issue_number = 7",
        [],
    )
    .unwrap();
    assert!(!sync::terminal_hold(&conn, &created.id).unwrap());
}

#[test]
fn the_assignee_can_arrive_on_a_later_look_without_another_read() {
    let store = open();
    enable(&store, PROJECT, "hivra", None);
    let mut fake = Fake::new(
        vec![gh_issue(7, "Fix the door", "", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    let created = only(&store);
    assert_eq!(created.assignee, None);
    assert!(wakes(&store).is_empty());
    let calls = fake.calls.len();
    poll_at(&store, &mut fake, 1_000, &mate());
    assert_eq!(fake.calls.len(), calls);
    let assigned = task(&store, &created.id);
    assert_eq!(assigned.assignee.as_deref(), Some(MATE));
    assert_eq!(
        wakes(&store),
        vec![format!("pick up task #{}", created.number)]
    );
    poll_at(&store, &mut fake, 2_000, &mate());
    assert_eq!(wakes(&store).len(), 1);
}

#[test]
fn a_stale_save_does_not_apply_and_enabling_needs_a_repo() {
    let store = open();
    let mut conn = store.lock_conn().unwrap();
    let mut fake = Fake::new(vec![], vec![]);
    let first = sync::set_setting(
        &mut conn,
        PROJECT,
        SettingWrite {
            enabled: false,
            label: None,
            repo: None,
            assignee: None,
            expected_version: 0,
        },
        &mut fake,
    )
    .unwrap();
    assert_eq!(first.version, 1);
    assert_eq!(first.label, "hivra");
    assert!(!first.enabled);
    let stale = sync::set_setting(
        &mut conn,
        PROJECT,
        SettingWrite {
            enabled: true,
            label: Some("nope"),
            repo: Some(REPO),
            assignee: Some(MATE),
            expected_version: 0,
        },
        &mut fake,
    )
    .unwrap();
    assert!(stale.stale);
    assert_eq!(stale.version, 1);
    assert!(!stale.enabled);
    assert!(fake.calls.is_empty());
    let missing = sync::set_setting(
        &mut conn,
        PROJECT,
        SettingWrite {
            enabled: true,
            label: Some("hivra"),
            repo: None,
            assignee: None,
            expected_version: 1,
        },
        &mut fake,
    );
    assert!(missing.is_err());
    assert!(!sync::get_setting(&conn, PROJECT).unwrap().enabled);
    assert_eq!(fake.calls, vec![format!("repo {PROJECT}")]);
    let bad = sync::set_setting(
        &mut conn,
        PROJECT,
        SettingWrite {
            enabled: true,
            label: Some("hivra"),
            repo: Some("not a repo"),
            assignee: Some("has space"),
            expected_version: 1,
        },
        &mut fake,
    );
    assert!(bad.is_err());
}

#[test]
fn a_read_that_lands_after_the_setting_changed_writes_nothing() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(vec![gh_issue(1, "Late", "", "OPEN", &["hivra"])], vec![]);
    let ptr: *const SessionStore = &store;
    fake.poke = Some(Box::new(move || {
        // The poll has dropped the database lock for the `gh` read. This is that window.
        let store = unsafe { &*ptr };
        let mut conn = store.lock_conn().unwrap();
        sync::set_setting(
            &mut conn,
            PROJECT,
            SettingWrite {
                enabled: true,
                label: Some("other"),
                repo: Some(REPO),
                assignee: Some(MATE),
                expected_version: 1,
            },
            &mut Fake::new(vec![], vec![]),
        )
        .unwrap();
    }));
    poll_at(&store, &mut fake, 0, &[]);
    assert!(ids(&store).is_empty());
    let conn = store.lock_conn().unwrap();
    let saved = sync::get_setting(&conn, PROJECT).unwrap();
    assert_eq!(saved.label, "other");
    assert_eq!(saved.version, 2);
}

#[test]
fn an_unreadable_row_is_not_treated_as_the_label_leaving() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![gh_issue(7, "Fix the door", "", "OPEN", &["hivra"])],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    fake.issues = vec![json!({"number": 7, "title": "Fix the door", "state": "OPEN"})];
    poll_at(&store, &mut fake, rules::MIN_POLL_MS, &[]);
    let stayed = only(&store);
    assert!(!stayed.github_paused);
    assert_eq!(stayed.title, "Fix the door");
}

#[test]
fn list_arguments_match_the_inbox_search() {
    let args = gh::list_args(
        "issue",
        REPO,
        &rules::search_query("issue", "hivra").unwrap(),
    );
    assert_eq!(
        args,
        vec![
            "issue",
            "list",
            "--state",
            "all",
            "--limit",
            "100",
            "--repo",
            REPO,
            "--json",
            "number,title,body,state,labels",
            "--search",
            "is:issue label:hivra",
        ]
    );
    let args = gh::list_args(
        "pr",
        REPO,
        &rules::search_query("pull_request", "needs hivra").unwrap(),
    );
    assert!(args.iter().any(|arg| arg == "is:pr label:\"needs hivra\""));
    assert!(args
        .iter()
        .any(|arg| arg == "number,title,body,state,labels,mergedAt"));
}

#[test]
fn an_issue_row_that_is_really_a_pull_request_is_ignored() {
    let store = open();
    enable(&store, PROJECT, "hivra", Some(MATE));
    let mut fake = Fake::new(
        vec![json!({
            "number": 9,
            "title": "Not an issue",
            "state": "OPEN",
            "labels": [{ "name": "hivra" }],
            "pull_request": { "url": "https://github.com/acme/web/pull/9" }
        })],
        vec![],
    );
    poll_at(&store, &mut fake, 0, &[]);
    assert!(ids(&store).is_empty());
}
