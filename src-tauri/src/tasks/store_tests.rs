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
fn a_cycle_past_the_old_depth_bound_is_refused() {
    let store = mem();
    let who = person("proj");
    let root = make(&store, &who, "root", None);
    let mut conn = store.lock_conn().unwrap();
    let status_id: String = conn
        .query_row(
            "SELECT status_id FROM tasks WHERE id = ?1",
            [&root.id],
            |row| row.get(0),
        )
        .unwrap();
    let mut parent = root.id.clone();
    let mut leaf = String::new();
    // 1002 tasks in a line. The old bound kept a node 1000 steps away and missed the root one step further.
    for n in 1..=1001 {
        let id = format!("task-deep-{n}");
        conn.execute(
            "INSERT INTO tasks (
               id, project_id, number, title, description, status_id, priority, labels, parent_id,
               sort_key, version, source, created_by, needs_you, failed, created_at, updated_at
             ) VALUES (?1, 'proj', ?2, ?3, '', ?4, 'none', '[]', ?5, ?6, 1, 'person', 'person', 0, 0, 1, 1)",
            rusqlite::params![
                id,
                n + 1,
                n.to_string(),
                status_id,
                parent,
                format!("{n:08}")
            ],
        )
        .unwrap();
        parent = id.clone();
        leaf = id;
    }
    let refused = update(
        &mut conn,
        &who,
        &UpdateInput {
            id: root.id.clone(),
            version: Some(1),
            parent: Set::Value(leaf),
            ..Default::default()
        },
        2,
    );
    assert!(
        refused.is_err(),
        "a cycle past the depth bound must be refused, got {refused:?}"
    );
    let parent_now: Option<String> = conn
        .query_row(
            "SELECT parent_id FROM tasks WHERE id = ?1",
            [&root.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(parent_now.is_none());
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
            status: Some("Done".into()),
            ..Default::default()
        },
        2,
    )
    .unwrap();
    assert_eq!(status.task.status, "Done");
    assert!(!status.stale);
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
    let marked = update(
        &mut conn,
        &worker,
        &UpdateInput {
            id: follow.task.id.clone(),
            version: Some(2),
            status: Some("Done".into()),
            ..Default::default()
        },
        5,
    )
    .unwrap();
    assert_eq!(marked.task.status, "Done");
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
            version: Some(3),
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
    assert_eq!(text, format!("pick up task #1 (id {})", task.id));
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
    let key = format!("task-pickup:{id}", id = task.id);
    let mate_two: String = conn
        .query_row(
            "SELECT text FROM firstmate_wakes WHERE owner_session = 'mate-2' AND key = ?1",
            [&key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(mate_two, format!("pick up task #1 (id {})", task.id));
    let wakes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM firstmate_wakes WHERE key = ?1",
            [&key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(wakes, 2);
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id.clone(),
            version: Some(2),
            assignee: Set::Value("mate-2".into()),
            ..Default::default()
        },
        3,
    )
    .unwrap();
    let still_two: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM firstmate_wakes WHERE key = ?1",
            [&key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(still_two, 2);
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
    assert_eq!(nobody, 2);
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
    assert_eq!(still, 2);
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
    // Windows can't remove a database file that is still open.
    drop(store);
    let dir = crate::fs::canonical(&dir).unwrap();
    let temp = crate::fs::canonical(std::env::temp_dir()).unwrap();
    assert!(
        dir.starts_with(&temp),
        "refusing to delete outside the temp folder"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_agent_task_carries_its_cli_and_how_long_it_has_been_working() {
    let store = mem();
    let who = person("crew");
    let task = make(&store, &who, "Brief", None);
    assert_eq!(task.cli, None);
    assert_eq!(task.working_since, None);
    assert_eq!(task.finished_at, None);
    assert_eq!(task.chat_id, None);
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
         VALUES ('chat-1', '/work/proj', 'claude', 'opus', 'chat', 'Worker', 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO delegations (id, owner_session, root_id, child_session, request_id, state, delivery, created_at, updated_at)
         VALUES ('del-1', 'owner', 'del-1', 'chat-1', 'req-1', 'running', 'keep', 5000, 5000)",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE tasks SET delegation_id = 'del-1' WHERE id = ?1",
        [&task.id],
    )
    .unwrap();
    let running = get(&conn, &who, &task.id).unwrap();
    assert_eq!(running.cli.as_deref(), Some("claude"));
    assert_eq!(running.working_since, Some(5000));
    assert_eq!(running.finished_at, None);
    assert_eq!(running.chat_id.as_deref(), Some("chat-1"));
    conn.execute(
        "UPDATE delegations SET state = 'completed', settled_at = 9000 WHERE id = 'del-1'",
        [],
    )
    .unwrap();
    let done = get(&conn, &who, &task.id).unwrap();
    assert_eq!(done.working_since, None);
    assert_eq!(done.finished_at, Some(9000));
    conn.execute(
        "UPDATE tasks SET delegation_id = 'missing' WHERE id = ?1",
        [&task.id],
    )
    .unwrap();
    let gone = get(&conn, &who, &task.id).unwrap();
    assert_eq!(gone.cli, None);
    conn.execute("DROP TABLE delegations", []).unwrap();
    let missing = get(&conn, &who, &task.id).unwrap();
    assert_eq!(missing.chat_id, None);
    let names: Vec<String> = statuses(&conn, &who)
        .unwrap()
        .into_iter()
        .map(|status| status.id)
        .collect();
    assert!(names.contains(&"In progress".to_string()));
    assert!(names
        .iter()
        .all(|name| names.iter().filter(|other| *other == name).count() == 1));
}

#[test]
fn a_project_does_not_see_another_projects_statuses() {
    let store = mem();
    let conn = store.lock_conn().unwrap();
    ensure_tables(&conn).unwrap();
    let mine = person("my project");
    let other = person("café");
    statuses(&conn, &mine).unwrap();
    statuses(&conn, &other).unwrap();
    conn.execute(
        "INSERT INTO task_statuses (id, project_id, name, category, position, color, version)
         VALUES ('ts-blocked', 'café', 'Blocked', 'started', 9, NULL, 1)",
        [],
    )
    .unwrap();
    let rows = statuses(&conn, &mine).unwrap();
    assert!(rows.iter().all(|row| row.project_id == "my project"));
    assert!(rows.iter().all(|row| row.name != "Blocked"));
    assert!(rows.iter().any(|row| row.name == "Todo"));
    let theirs = statuses(&conn, &other).unwrap();
    assert!(theirs.iter().all(|row| row.project_id == "café"));
    assert!(theirs.iter().any(|row| row.name == "Blocked"));
    let spaced = statuses(&conn, &person("  my project  ")).unwrap();
    assert!(spaced.iter().all(|row| row.project_id == "my project"));
    let windows = statuses(&conn, &person("C:\\Code\\Other")).unwrap();
    assert!(windows
        .iter()
        .all(|row| row.project_id == "C:\\Code\\Other"));
    assert!(windows.iter().all(|row| row.name != "Blocked"));
}

// WP-250: pickup rules.

fn rule(
    owner: &str,
    statuses: &[&str],
    labels: &[&str],
    at: i64,
) -> super::super::pickup::PickupRule {
    super::super::pickup::PickupRule {
        owner_session: owner.into(),
        project: Some("app".into()),
        statuses: statuses.iter().map(|s| s.to_string()).collect(),
        labels: labels.iter().map(|s| s.to_string()).collect(),
        enabled: true,
        created_at: at,
    }
}

/// A chat in the store, so a rule may name it.
fn chat(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
         VALUES (?1, '/work/app', 'claude', 'opus', 'chat', 'Mate', 1, 1)",
        [id],
    )
    .unwrap();
}

fn put_rule(conn: &rusqlite::Connection, rule: &super::super::pickup::PickupRule, now: i64) {
    chat(conn, &rule.owner_session);
    super::super::pickup::put(conn, rule, now).unwrap();
}

fn wakes_for(conn: &rusqlite::Connection, owner: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM firstmate_wakes WHERE owner_session = ?1",
        [owner],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn a_matching_task_goes_to_the_rule_owner_once() {
    let store = mem();
    let who = person("app");
    let mut conn = store.lock_conn().unwrap();
    put_rule(&conn, &rule("mate-1", &[], &["bug"], 1), 1);
    let task = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Fix the crash".into(),
            labels: vec!["bug".into()],
            ..Default::default()
        },
        2,
    )
    .unwrap()
    .task;
    let stored = get(&conn, &who, &task.id).unwrap();
    assert_eq!(stored.assignee.as_deref(), Some("mate-1"));
    assert_eq!(wakes_for(&conn, "mate-1"), 1);
    // A later edit of a picked-up task neither moves it nor wakes again.
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id.clone(),
            version: Some(stored.version),
            title: Some("Fix the crash on launch".into()),
            ..Default::default()
        },
        3,
    )
    .unwrap();
    assert_eq!(wakes_for(&conn, "mate-1"), 1);
}

#[test]
fn a_task_that_starts_matching_later_is_picked_up_then() {
    let store = mem();
    let who = person("app");
    let mut conn = store.lock_conn().unwrap();
    put_rule(&conn, &rule("mate-1", &["Todo"], &[], 1), 1);
    let task = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Later".into(),
            ..Default::default()
        },
        2,
    )
    .unwrap()
    .task;
    assert_eq!(task.assignee, None);
    assert_eq!(wakes_for(&conn, "mate-1"), 0);
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id.clone(),
            version: Some(task.version),
            status: Some("Todo".into()),
            ..Default::default()
        },
        3,
    )
    .unwrap();
    assert_eq!(
        get(&conn, &who, &task.id).unwrap().assignee.as_deref(),
        Some("mate-1")
    );
    assert_eq!(wakes_for(&conn, "mate-1"), 1);
}

#[test]
fn a_rule_never_takes_a_persons_task_or_undoes_an_unassign() {
    let store = mem();
    let who = person("app");
    let mut conn = store.lock_conn().unwrap();
    put_rule(&conn, &rule("mate-1", &["Backlog"], &[], 1), 1);
    let mine = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Mine".into(),
            assignee: Some("person".into()),
            ..Default::default()
        },
        2,
    )
    .unwrap()
    .task;
    assert_eq!(mine.assignee.as_deref(), Some("person"));
    let taken = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Taken".into(),
            ..Default::default()
        },
        3,
    )
    .unwrap()
    .task;
    let taken = get(&conn, &who, &taken.id).unwrap();
    assert_eq!(taken.assignee.as_deref(), Some("mate-1"));
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: taken.id.clone(),
            version: Some(taken.version),
            assignee: Set::Clear,
            ..Default::default()
        },
        4,
    )
    .unwrap();
    assert_eq!(get(&conn, &who, &taken.id).unwrap().assignee, None);
}

#[test]
fn the_oldest_rule_wins_and_a_catch_all_rule_is_refused() {
    let store = mem();
    let who = person("app");
    let mut conn = store.lock_conn().unwrap();
    chat(&conn, "mate-0");
    assert!(super::super::pickup::put(&conn, &rule("mate-0", &[], &[], 1), 1).is_err());
    put_rule(&conn, &rule("mate-2", &["Backlog"], &[], 5), 5);
    put_rule(&conn, &rule("mate-1", &["Backlog"], &[], 9), 9);
    // Editing a rule keeps its place.
    put_rule(&conn, &rule("mate-2", &["Backlog", "Todo"], &[], 20), 20);
    let task = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Who".into(),
            ..Default::default()
        },
        21,
    )
    .unwrap()
    .task;
    assert_eq!(
        get(&conn, &who, &task.id).unwrap().assignee.as_deref(),
        Some("mate-2")
    );
}

fn unassign(conn: &mut rusqlite::Connection, who: &Actor, id: &str, now: i64) {
    let task = get(conn, who, id).unwrap();
    update(
        conn,
        who,
        &UpdateInput {
            id: id.to_string(),
            version: Some(task.version),
            assignee: Set::Clear,
            ..Default::default()
        },
        now,
    )
    .unwrap();
}

#[test]
fn a_rule_must_name_a_real_chat_and_one_project() {
    let store = mem();
    let conn = store.lock_conn().unwrap();
    // A first mate's name, the person, or a chat that isn't in the store is refused.
    for owner in ["Scout", "person", "mate-gone"] {
        assert!(
            super::super::pickup::put(&conn, &rule(owner, &["Todo"], &[], 1), 1).is_err(),
            "{owner}"
        );
    }
    chat(&conn, "mate-1");
    let mut everywhere = rule("mate-1", &["Todo"], &[], 1);
    everywhere.project = None;
    assert!(super::super::pickup::put(&conn, &everywhere, 1).is_err());
    assert!(super::super::pickup::put(&conn, &rule("mate-1", &["Todo"], &[], 1), 1).is_ok());
}

#[test]
fn a_rule_whose_chat_was_deleted_takes_nothing() {
    let store = mem();
    let who = person("app");
    let mut conn = store.lock_conn().unwrap();
    put_rule(&conn, &rule("mate-1", &[], &["bug"], 1), 1);
    conn.execute("DELETE FROM sessions WHERE id = 'mate-1'", [])
        .unwrap();
    let task = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Orphan".into(),
            labels: vec!["bug".into()],
            ..Default::default()
        },
        2,
    )
    .unwrap()
    .task;
    assert_eq!(get(&conn, &who, &task.id).unwrap().assignee, None);
    assert_eq!(wakes_for(&conn, "mate-1"), 0);
}

#[test]
fn an_unassigned_task_stays_unassigned_through_later_edits() {
    let store = mem();
    let who = person("app");
    let mut conn = store.lock_conn().unwrap();
    put_rule(&conn, &rule("mate-1", &["Backlog", "Todo"], &[], 1), 1);
    let task = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Stop this".into(),
            ..Default::default()
        },
        2,
    )
    .unwrap()
    .task;
    assert_eq!(
        get(&conn, &who, &task.id).unwrap().assignee.as_deref(),
        Some("mate-1")
    );
    unassign(&mut conn, &who, &task.id, 3);
    // Move it on the board, retitle it and drag it to another matching status: the rule leaves it alone.
    let edits = [
        UpdateInput {
            sort_key: Some("b".into()),
            ..Default::default()
        },
        UpdateInput {
            title: Some("Stop this, really".into()),
            ..Default::default()
        },
        UpdateInput {
            status: Some("Todo".into()),
            ..Default::default()
        },
        UpdateInput {
            comment: Some("leave it".into()),
            ..Default::default()
        },
    ];
    for (at, edit) in edits.into_iter().enumerate() {
        let now = get(&conn, &who, &task.id).unwrap();
        update(
            &mut conn,
            &who,
            &UpdateInput {
                id: task.id.clone(),
                version: Some(now.version),
                ..edit
            },
            4 + at as i64,
        )
        .unwrap();
        assert_eq!(
            get(&conn, &who, &task.id).unwrap().assignee,
            None,
            "edit {at}"
        );
    }
    // Even once the old wake is gone, nothing wakes the first mate again.
    conn.execute("DELETE FROM firstmate_wakes", []).unwrap();
    let now = get(&conn, &who, &task.id).unwrap();
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: task.id.clone(),
            version: Some(now.version),
            title: Some("Again".into()),
            ..Default::default()
        },
        20,
    )
    .unwrap();
    assert_eq!(get(&conn, &who, &task.id).unwrap().assignee, None);
    assert_eq!(wakes_for(&conn, "mate-1"), 0);
}

#[test]
fn a_rule_never_takes_from_another_project_and_the_wake_names_the_task_id() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    put_rule(&conn, &rule("mate-1", &[], &["bug"], 1), 1);
    let other = person("other");
    let theirs = create(
        &mut conn,
        &other,
        &CreateInput {
            title: "Not yours".into(),
            labels: vec!["bug".into()],
            ..Default::default()
        },
        2,
    )
    .unwrap()
    .task;
    assert_eq!(get(&conn, &other, &theirs.id).unwrap().assignee, None);
    assert_eq!(wakes_for(&conn, "mate-1"), 0);
    let who = person("app");
    let ours = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Yours".into(),
            labels: vec!["bug".into()],
            ..Default::default()
        },
        3,
    )
    .unwrap()
    .task;
    let text: String = conn
        .query_row(
            "SELECT text FROM firstmate_wakes WHERE owner_session = 'mate-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(text, format!("pick up task #1 (id {})", ours.id));
}

#[test]
fn a_rule_never_takes_a_done_or_cancelled_task() {
    let store = mem();
    let who = person("app");
    let mut conn = store.lock_conn().unwrap();
    put_rule(&conn, &rule("mate-1", &[], &["bug"], 1), 1);
    let done = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Already done".into(),
            status: Some("Done".into()),
            labels: vec!["bug".into()],
            ..Default::default()
        },
        2,
    )
    .unwrap()
    .task;
    assert_eq!(get(&conn, &who, &done.id).unwrap().assignee, None);
    // A person's own task, unassigned and then cancelled, is not handed out either.
    let mine = create(
        &mut conn,
        &who,
        &CreateInput {
            title: "Mine".into(),
            labels: vec!["bug".into()],
            assignee: Some("person".into()),
            ..Default::default()
        },
        3,
    )
    .unwrap()
    .task;
    let now = get(&conn, &who, &mine.id).unwrap();
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: mine.id.clone(),
            version: Some(now.version),
            assignee: Set::Clear,
            status: Some("Cancelled".into()),
            ..Default::default()
        },
        4,
    )
    .unwrap();
    let now = get(&conn, &who, &mine.id).unwrap();
    update(
        &mut conn,
        &who,
        &UpdateInput {
            id: mine.id.clone(),
            version: Some(now.version),
            title: Some("Mine, cancelled".into()),
            ..Default::default()
        },
        5,
    )
    .unwrap();
    assert_eq!(get(&conn, &who, &mine.id).unwrap().assignee, None);
    assert_eq!(wakes_for(&conn, "mate-1"), 0);
}
