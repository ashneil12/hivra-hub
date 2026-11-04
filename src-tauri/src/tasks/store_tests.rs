use super::*;
use crate::session_store::SessionStore;

fn mem() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn person(project: &str) -> Actor {
    Actor {
        id: "person".into(),
        project: project.into(),
        kind: "person".into(),
    }
}

fn agent(id: &str, project: &str) -> Actor {
    Actor {
        id: id.into(),
        project: project.into(),
        kind: "agent".into(),
    }
}

fn make(store: &SessionStore, actor: &Actor, title: &str, parent: Option<&str>) -> Task {
    let mut conn = store.lock_conn().unwrap();
    create(
        &mut conn,
        actor,
        &CreateInput {
            title: title.into(),
            parent_id: parent.map(str::to_string),
            ..Default::default()
        },
        1,
    )
    .unwrap()
    .task
}

fn set_status(store: &SessionStore, actor: &Actor, task: &Task, status: &str) -> Written {
    let mut conn = store.lock_conn().unwrap();
    update(
        &mut conn,
        actor,
        &UpdateInput {
            id: task.id.clone(),
            version: Some(task.version),
            status: Some(status.into()),
            ..Default::default()
        },
        2,
    )
    .unwrap()
}

fn fresh(store: &SessionStore, actor: &Actor, id: &str) -> Task {
    let conn = store.lock_conn().unwrap();
    get(&conn, actor, id).unwrap()
}

#[test]
fn a_stale_write_is_refused_and_keeps_the_first_one() {
    let store = mem();
    let who = person("proj");
    let task = make(&store, &who, "One", None);
    let mut conn = store.lock_conn().unwrap();
    let first = update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id.clone(),
            version: Some(1),
            title: Some("A".into()),
            ..Default::default()
        },
        2,
    )
    .unwrap();
    let second = update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id.clone(),
            version: Some(1),
            title: Some("B".into()),
            comment: Some("nope".into()),
            ..Default::default()
        },
        3,
    )
    .unwrap();
    assert!(!first.stale);
    assert!(second.stale);
    assert_eq!(second.task.title, "A");
    assert!(second.task.comments.is_empty());
    assert!(second.changed.is_empty());
    assert_eq!(get(&conn, &who, &task.id).unwrap().title, "A");
}

#[test]
fn two_comments_both_land_and_the_version_stays() {
    let store = mem();
    let who = person("proj");
    let task = make(&store, &who, "One", None);
    let mut conn = store.lock_conn().unwrap();
    for body in ["one", "two"] {
        let written = update(
            &mut conn,
            &who,
            &UpdateInput {
                id: task.id.clone(),
                comment: Some(body.into()),
                ..Default::default()
            },
            2,
        )
        .unwrap();
        assert!(!written.stale);
        assert_eq!(written.task.version, 1);
    }
    assert_eq!(get(&conn, &who, &task.id).unwrap().comments.len(), 2);
}

#[test]
fn a_parent_must_be_a_live_task_in_this_project_and_not_a_cycle() {
    let store = mem();
    let who = person("proj");
    let a = make(&store, &who, "A", None);
    let b = make(&store, &who, "B", Some(&a.id));
    let mut conn = store.lock_conn().unwrap();
    let cycle = update(
        &mut conn,
        &who,
        &UpdateInput {
            id: a.id.clone(),
            version: Some(a.version),
            parent: Set::Value(b.id.clone()),
            ..Default::default()
        },
        2,
    );
    assert_eq!(
        cycle.unwrap_err(),
        "A task can't be a sub-task of itself or of its own sub-tasks."
    );
    let itself = update(
        &mut conn,
        &who,
        &UpdateInput {
            id: a.id.clone(),
            version: Some(a.version),
            parent: Set::Value(a.id.clone()),
            ..Default::default()
        },
        2,
    );
    assert_eq!(
        itself.unwrap_err(),
        "A task can't be a sub-task of itself or of its own sub-tasks."
    );
    let missing = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "C".into(),
            parent_id: Some("task-missing".into()),
            ..Default::default()
        },
        2,
    );
    assert_eq!(
        missing.unwrap_err(),
        "That parent task isn't available anymore."
    );
    let other = create(
        &mut conn,
        &person("other"),
        &CreateInput {
            title: "Elsewhere".into(),
            ..Default::default()
        },
        2,
    )
    .unwrap();
    let crossed = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "D".into(),
            parent_id: Some(other.task.id),
            ..Default::default()
        },
        2,
    );
    assert_eq!(
        crossed.unwrap_err(),
        "That parent task isn't available anymore."
    );
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: a.id.clone(),
            version: Some(a.version),
            trash: true,
            ..Default::default()
        },
        3,
    )
    .unwrap();
    let trashed = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "E".into(),
            parent_id: Some(a.id),
            ..Default::default()
        },
        4,
    );
    assert_eq!(
        trashed.unwrap_err(),
        "That parent task isn't available anymore."
    );
}

#[test]
fn a_deep_chain_is_allowed() {
    let store = mem();
    let who = person("proj");
    let mut parent = None;
    for index in 0..20 {
        let task = make(&store, &who, &index.to_string(), parent.as_deref());
        parent = Some(task.id);
    }
    assert!(parent.is_some());
}

#[test]
fn a_parent_closes_when_every_child_is_closed_and_one_is_done() {
    let store = mem();
    let who = person("proj");
    let grand = make(&store, &who, "Grand", None);
    let parent = make(&store, &who, "Parent", Some(&grand.id));
    let done = make(&store, &who, "Done child", Some(&parent.id));
    let other = make(&store, &who, "Other", Some(&parent.id));
    set_status(&store, &who, &done, "Done");
    assert_eq!(fresh(&store, &who, &parent.id).status, "Backlog");
    set_status(&store, &who, &other, "Cancelled");
    assert_eq!(fresh(&store, &who, &parent.id).status, "Done");
    assert_eq!(fresh(&store, &who, &grand.id).status, "Done");
}

#[test]
fn all_cancelled_or_one_open_or_the_flag_off_leaves_the_parent() {
    let store = mem();
    let who = person("proj");
    let parent = make(&store, &who, "Parent", None);
    let first = make(&store, &who, "A", Some(&parent.id));
    let second = make(&store, &who, "B", Some(&parent.id));
    set_status(&store, &who, &first, "Cancelled");
    set_status(&store, &who, &second, "Cancelled");
    assert_eq!(fresh(&store, &who, &parent.id).status, "Backlog");

    let open = make(&store, &who, "Open", None);
    let child = make(&store, &who, "Child", Some(&open.id));
    let still = make(&store, &who, "Still", Some(&open.id));
    set_status(&store, &who, &child, "Done");
    assert_eq!(fresh(&store, &who, &still.id).status, "Backlog");
    assert_eq!(fresh(&store, &who, &open.id).status, "Backlog");

    let held = make(&store, &who, "Held", None);
    let only = make(&store, &who, "Only", Some(&held.id));
    store
        .lock_conn()
        .unwrap()
        .execute(
            "UPDATE project_task_settings SET auto_close_parent = 0 WHERE project_id = 'proj'",
            [],
        )
        .unwrap();
    set_status(&store, &who, &only, "Done");
    assert_eq!(fresh(&store, &who, &held.id).status, "Backlog");
}

#[test]
fn trashing_the_open_child_closes_the_parent_and_a_done_child_closes_it_too() {
    let store = mem();
    let who = person("proj");
    let parent = make(&store, &who, "Parent", None);
    let done = make(&store, &who, "Done", Some(&parent.id));
    let open = make(&store, &who, "Open", Some(&parent.id));
    set_status(&store, &who, &done, "Done");
    {
        let mut conn = store.lock_conn().unwrap();
        update(
            &mut conn,
            &who,
            &UpdateInput {
                id: open.id.clone(),
                version: Some(open.version),
                trash: true,
                ..Default::default()
            },
            5,
        )
        .unwrap();
        assert_eq!(get(&conn, &who, &parent.id).unwrap().status, "Done");
    }

    let fresh_parent = make(&store, &who, "New", None);
    let mut conn = store.lock_conn().unwrap();
    create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Already done".into(),
            status: Some("Done".into()),
            parent_id: Some(fresh_parent.id.clone()),
            ..Default::default()
        },
        6,
    )
    .unwrap();
    assert_eq!(get(&conn, &who, &fresh_parent.id).unwrap().status, "Done");
}

#[test]
fn trashing_a_parent_trashes_the_subtree_and_keeps_an_earlier_time() {
    let store = mem();
    let who = person("proj");
    let parent = make(&store, &who, "Parent", None);
    let child = make(&store, &who, "Child", Some(&parent.id));
    let grand = make(&store, &who, "Grand", Some(&child.id));
    let mut conn = store.lock_conn().unwrap();
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: grand.id.clone(),
            version: Some(grand.version),
            trash: true,
            ..Default::default()
        },
        10,
    )
    .unwrap();
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: parent.id.clone(),
            version: Some(parent.version),
            trash: true,
            ..Default::default()
        },
        20,
    )
    .unwrap();
    assert_eq!(get(&conn, &who, &child.id).unwrap().trashed_at, Some(20));
    assert_eq!(get(&conn, &who, &grand.id).unwrap().trashed_at, Some(10));
    assert!(list(&conn, &who).unwrap().is_empty());
}

#[test]
fn an_agent_can_file_a_follow_up_but_not_rewrite_someone_elses_task() {
    let store = mem();
    let owner = person("proj");
    let theirs = make(&store, &owner, "Theirs", None);
    let worker = agent("worker", "proj");
    let mut conn = store.lock_conn().unwrap();
    let refused = update(
        &mut conn,
        &worker,
        &UpdateInput {
            id: theirs.id.clone(),
            version: Some(1),
            title: Some("Mine".into()),
            ..Default::default()
        },
        2,
    );
    assert_eq!(
        refused.unwrap_err(),
        "You can comment, or change the status. The wording is the author's."
    );
    let status = update(
        &mut conn,
        &worker,
        &UpdateInput {
            id: theirs.id.clone(),
            version: Some(1),
            status: Some("In progress".into()),
            ..Default::default()
        },
        2,
    );
    assert_eq!(
        status.unwrap_err(),
        "This status follows the work. Agents don't set it."
    );
    let follow = create(
        &mut conn,
        &worker,
        &CreateInput {
            title: "Follow up".into(),
            parent_id: Some(theirs.id.clone()),
            ..Default::default()
        },
        3,
    )
    .unwrap();
    let edited = update(
        &mut conn,
        &worker,
        &UpdateInput {
            id: follow.task.id.clone(),
            version: Some(1),
            title: Some("Follow up, revised".into()),
            ..Default::default()
        },
        4,
    )
    .unwrap();
    assert_eq!(edited.task.title, "Follow up, revised");
    assert_eq!(edited.task.created_by, "worker");
    let mapped = create(
        &mut conn,
        &worker,
        &CreateInput {
            title: "No".into(),
            status: Some("In progress".into()),
            ..Default::default()
        },
        5,
    );
    assert_eq!(
        mapped.unwrap_err(),
        "This status follows the work. Agents don't set it."
    );
    update(
        &mut conn,
        &owner,
        &UpdateInput {
            id: theirs.id.clone(),
            version: Some(1),
            status: Some("Todo".into()),
            ..Default::default()
        },
        6,
    )
    .unwrap();
    conn.execute(
        "UPDATE tasks SET delegation_id = 't-fake' WHERE id = ?1",
        [&theirs.id],
    )
    .unwrap();
    let linked = update(
        &mut conn,
        &worker,
        &UpdateInput {
            id: theirs.id.clone(),
            version: Some(2),
            status: Some("Backlog".into()),
            ..Default::default()
        },
        7,
    );
    assert_eq!(linked.unwrap_err(), "This task follows its work.");
    let source = create(
        &mut conn,
        &worker,
        &CreateInput {
            title: "From github".into(),
            source: Some("github".into()),
            ..Default::default()
        },
        8,
    );
    assert_eq!(
        source.unwrap_err(),
        "An agent can't set where a task came from."
    );
    let person_status = update(
        &mut conn,
        &owner,
        &UpdateInput {
            id: follow.task.id,
            version: Some(2),
            status: Some("In progress".into()),
            ..Default::default()
        },
        8,
    )
    .unwrap();
    assert_eq!(person_status.task.status, "In progress");
    assert_eq!(
        get(&conn, &agent("worker", "other"), &theirs.id).unwrap_err(),
        "No task with that id."
    );
}

#[test]
fn assigning_wakes_the_first_mate_once_and_not_the_person() {
    let store = mem();
    let who = person("proj");
    let mut conn = store.lock_conn().unwrap();
    let task = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Pick me".into(),
            assignee: Some("mate-1".into()),
            ..Default::default()
        },
        1,
    )
    .unwrap()
    .task;
    let text: String = conn
        .query_row(
            "SELECT text FROM firstmate_wakes WHERE key = ?1",
            [format!("task-pickup:{id}", id = task.id)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(text, "pick up task #1");
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id.clone(),
            version: Some(task.version),
            assignee: Set::Value("mate-2".into()),
            ..Default::default()
        },
        2,
    )
    .unwrap();
    let wakes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM firstmate_wakes WHERE key = ?1",
            [format!("task-pickup:{id}", id = task.id)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(wakes, 1);
    let quiet = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Quiet".into(),
            ..Default::default()
        },
        3,
    )
    .unwrap();
    let nobody: i64 = conn
        .query_row("SELECT COUNT(*) FROM firstmate_wakes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(nobody, 1);
    create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Self".into(),
            assignee: Some("person".into()),
            ..Default::default()
        },
        4,
    )
    .unwrap();
    let still: i64 = conn
        .query_row("SELECT COUNT(*) FROM firstmate_wakes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(still, 1);
    assert!(quiet.task.assignee.is_none());
}

#[test]
fn a_comment_with_no_work_behind_it_is_only_a_comment() {
    let store = mem();
    let who = person("proj");
    let task = make(&store, &who, "Note", None);
    let mut conn = store.lock_conn().unwrap();
    let written = update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id.clone(),
            comment: Some("  hello  ".into()),
            ..Default::default()
        },
        2,
    )
    .unwrap();
    assert_eq!(written.task.comments[0].body, "hello");
    let steered: i64 = conn
        .query_row("SELECT COUNT(*) FROM steer_messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(steered, 0);
    let empty = update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id,
            comment: Some("   ".into()),
            ..Default::default()
        },
        3,
    );
    assert_eq!(empty.unwrap_err(), "The comment is empty.");
}

#[test]
fn titles_and_project_keys_are_stored_as_given() {
    let store = mem();
    let who = person("proj");
    let mut conn = store.lock_conn().unwrap();
    assert_eq!(
        create(
            &mut conn,
            &who,
            &CreateInput {
                title: "   ".into(),
                ..Default::default()
            },
            1
        )
        .unwrap_err(),
        "The title is empty."
    );
    let kept = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "  Überprüfung\r\nnext  ".into(),
            description: "line\r\nline".into(),
            ..Default::default()
        },
        2,
    )
    .unwrap();
    assert_eq!(kept.task.title, "Überprüfung\r\nnext");
    assert_eq!(kept.task.description, "line\r\nline");
    for key in [
        "..",
        "My Project",
        "C:\\Users\\ash\\My Project",
        "Überprüfung",
    ] {
        let stored = create(
            &mut conn,
            &person(key),
            &CreateInput {
                title: "Kept".into(),
                ..Default::default()
            },
            3,
        )
        .unwrap();
        assert_eq!(stored.task.project_id, key);
        assert_eq!(
            get(&conn, &person(key), &stored.task.id)
                .unwrap()
                .project_id,
            key
        );
    }
}

#[test]
fn a_bad_labels_value_reads_back_as_none_and_the_tables_open_twice() {
    let store = mem();
    let who = person("proj");
    let task = make(&store, &who, "Labels", None);
    let conn = store.lock_conn().unwrap();
    ensure_tables(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    conn.execute(
        "UPDATE tasks SET labels = 'not-json' WHERE id = ?1",
        [&task.id],
    )
    .unwrap();
    assert!(get(&conn, &who, &task.id).unwrap().labels.is_empty());
}

#[test]
fn tasks_and_their_links_are_still_there_after_the_file_is_opened_again() {
    let stamp = uuid::Uuid::new_v4().simple();
    let dir = std::env::temp_dir().join(format!("wp70 tasks Überprüfung {stamp}"));
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("marker.txt");
    std::fs::write(&marker, "keep").unwrap();
    let db = dir.join("monocode.db");
    let id = {
        let store = SessionStore::open(db.clone()).unwrap();
        let task = make(&store, &person(".."), "Survives", None);
        task.id
    };
    let store = SessionStore::open(db).unwrap();
    let task = fresh(&store, &person(".."), &id);
    assert_eq!(task.title, "Survives");
    assert_eq!(task.project_id, "..");
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "keep");
    let again = make(&store, &person(".."), "Second", None);
    assert_ne!(task.number, again.number);
    let dir = crate::fs::canonical(&dir).unwrap();
    let temp = crate::fs::canonical(std::env::temp_dir()).unwrap();
    assert!(
        dir.starts_with(&temp),
        "refusing to delete outside the temp folder"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
