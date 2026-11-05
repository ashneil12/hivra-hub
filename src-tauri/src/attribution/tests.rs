use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

use super::logic::{LedgerRow, Tier};
use super::{store_credit, SessionStore};

static TICK: AtomicU64 = AtomicU64::new(0);

struct Scratch {
    path: PathBuf,
}

impl Scratch {
    fn new() -> Self {
        let n = TICK.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("hivra-wp86-{}-{n}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let tmp = std::env::temp_dir();
        if self.path.starts_with(&tmp) && self.path != tmp {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn row(sha: &str, tier: Tier, chat: Option<&str>, task: Option<&str>) -> LedgerRow {
    LedgerRow {
        sha: sha.into(),
        tier,
        chat_id: chat.map(str::to_string),
        task_id: task.map(str::to_string),
        agent: Some("Ada".into()),
        file_count: 2,
        line_count: 10,
        subject: Some("by hand".into()),
    }
}

fn stored_tier(store: &SessionStore, repo: &str, sha: &str) -> String {
    let conn = store.lock_conn().unwrap();
    conn.query_row(
        "SELECT tier, subject, chat_id FROM attribution_commits WHERE repo = ?1 AND sha = ?2",
        [repo, sha],
        |row| row.get::<_, String>(0),
    )
    .unwrap()
}

fn activity_count(store: &SessionStore) -> i64 {
    let conn = store.lock_conn().unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM activity WHERE kind = 'git.commit'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn a_later_window_cannot_downgrade_a_credit() {
    let scratch = Scratch::new();
    let path = scratch.path().join("ledger.db");
    let first = SessionStore::open(path.clone()).unwrap();
    let second = SessionStore::open(path).unwrap();
    store_credit(
        &first,
        "repo-a",
        row("abc1234", Tier::Confirmed, Some("chat-1"), Some("task-1")),
    )
    .unwrap();
    store_credit(&second, "repo-a", row("abc1234", Tier::Person, None, None)).unwrap();
    assert_eq!(stored_tier(&first, "repo-a", "abc1234"), "confirmed");
    let again = row(
        "abc1234",
        Tier::Confirmed,
        Some("other-chat"),
        Some("other-task"),
    );
    store_credit(&second, "repo-a", again).unwrap();
    let conn = first.lock_conn().unwrap();
    let chat: String = conn
        .query_row(
            "SELECT chat_id FROM attribution_commits WHERE repo = 'repo-a' AND sha = 'abc1234'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(chat, "chat-1");
}

#[test]
fn a_person_commit_can_be_raised_and_is_recorded_once() {
    let scratch = Scratch::new();
    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "INSERT INTO tasks (id, project_id, number, title, status_id, sort_key, source, created_by, created_at, updated_at)
         VALUES ('task-1', 'p', 1, 'Fix the gate', 's', 'a', 'test', 'ash', 1, 1)",
        [],
    )
    .unwrap();
    drop(conn);
    store_credit(&store, "repo-a", row("abc1234", Tier::Person, None, None)).unwrap();
    assert_eq!(activity_count(&store), 0);
    let mut inferred = row("abc1234", Tier::Inferred, Some("chat-1"), Some("task-1"));
    inferred.subject = Some("by hand".into());
    store_credit(&store, "repo-a", inferred.clone()).unwrap();
    assert_eq!(stored_tier(&store, "repo-a", "abc1234"), "inferred");
    store_credit(&store, "repo-a", inferred).unwrap();
    assert_eq!(activity_count(&store), 1);
    let conn = store.lock_conn().unwrap();
    let summary: String = conn
        .query_row(
            "SELECT summary FROM activity WHERE kind = 'git.commit'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(summary, "commit by Ada for Fix the gate");
    let subject: Option<String> = conn
        .query_row(
            "SELECT subject FROM attribution_commits WHERE sha = 'abc1234'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(subject.as_deref(), Some("by hand"));
}

#[test]
fn a_secret_in_the_subject_is_not_stored() {
    let scratch = Scratch::new();
    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    let mut credited = row("abc1234", Tier::Confirmed, Some("chat-1"), Some("task-1"));
    credited.subject = Some("api_key=sk-ant-api03-SECRETVALUE".into());
    store_credit(&store, "repo-a", credited).unwrap();
    let conn = store.lock_conn().unwrap();
    let dumped: String = conn
        .query_row(
            "SELECT COALESCE(subject, '') || COALESCE(agent, '') || COALESCE((SELECT summary FROM activity), '') FROM attribution_commits",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!dumped.contains("SECRETVALUE"));
}

#[test]
fn a_missing_task_table_is_not_a_failure() {
    let conn = Connection::open_in_memory().unwrap();
    let found = super::lookup_task(&conn, "chat-1").unwrap();
    assert!(found.is_none());
}

#[test]
fn the_tables_open_without_a_schema_bump() {
    let scratch = Scratch::new();
    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    let conn = store.lock_conn().unwrap();
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'attribution_%' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        names,
        vec![
            "attribution_commits".to_string(),
            "attribution_journal".to_string()
        ]
    );
    assert_eq!(
        crate::session_store::schema_version(&conn).unwrap(),
        crate::session_store::SCHEMA_VERSION
    );
}

#[test]
fn hooks_stay_inside_each_copy() {
    let scratch = Scratch::new();
    let first = scratch.path().join("data a");
    let second = scratch.path().join("data b");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let hooks_a = super::hooks::install_hooks(&first).unwrap();
    let hooks_b = super::hooks::install_hooks(&second).unwrap();
    let root_a = crate::fs::canonical(&first).unwrap();
    let root_b = crate::fs::canonical(&second).unwrap();
    assert!(hooks_a.starts_with(&root_a));
    assert!(hooks_b.starts_with(&root_b));
    assert_ne!(hooks_a, hooks_b);
    let script = fs::read(hooks_a.join("prepare-commit-msg")).unwrap();
    assert_eq!(
        script,
        fs::read(hooks_b.join("prepare-commit-msg")).unwrap()
    );
    assert!(std::str::from_utf8(&script)
        .unwrap()
        .contains("Hivra-Chat:"));
    let again = super::hooks::install_hooks(&first).unwrap();
    assert_eq!(fs::read(again.join("prepare-commit-msg")).unwrap(), script);
}

#[cfg(unix)]
#[test]
fn a_hook_symlink_is_not_followed() {
    use std::os::unix::fs::symlink;
    let scratch = Scratch::new();
    let data = scratch.path().join("data");
    let outside = scratch.path().join("outside.txt");
    fs::create_dir_all(data.join("attribution").join("hooks")).unwrap();
    fs::write(&outside, "keep").unwrap();
    symlink(
        &outside,
        data.join("attribution")
            .join("hooks")
            .join("prepare-commit-msg"),
    )
    .unwrap();
    assert!(super::hooks::install_hooks(&data).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
}

#[cfg(windows)]
#[test]
fn a_hook_that_is_not_a_file_is_refused() {
    let scratch = Scratch::new();
    let data = scratch.path().join("data");
    let outside = scratch.path().join("outside.txt");
    fs::create_dir_all(
        data.join("attribution")
            .join("hooks")
            .join("prepare-commit-msg"),
    )
    .unwrap();
    fs::write(&outside, "keep").unwrap();
    assert!(super::hooks::install_hooks(&data).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
}

#[test]
fn git_failing_does_not_drop_a_stored_credit() {
    let scratch = Scratch::new();
    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    store_credit(
        &store,
        "repo-a",
        row("abc1234", Tier::Confirmed, Some("chat-1"), Some("task-1")),
    )
    .unwrap();
    let missing = scratch.path().join("not a repo");
    fs::write(&missing, "nope").unwrap();
    assert!(super::refresh(&store, &missing, None).is_err());
    assert_eq!(stored_tier(&store, "repo-a", "abc1234"), "confirmed");
}

fn git(repo: &Path, env: &[(&str, &str)], args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::delivery::child("git");
    cmd.arg("--no-pager").arg("-C").arg(repo).args(args);
    cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    for key in [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
    ] {
        cmd.env_remove(key);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    let out = super::git::run_limited(cmd, std::time::Duration::from_secs(20))
        .map_err(|_| "git didn't answer".to_string())?;
    Ok(out)
}

#[test]
fn a_crew_commit_carries_the_trailers_and_the_repo_hook_still_runs() {
    let scratch = Scratch::new();
    let repo = scratch.path().join("a b").join("café");
    fs::create_dir_all(&repo).unwrap();
    let home = scratch.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let global = scratch.path().join("gitconfig");
    fs::write(
        &global,
        "[user]\n\tname = Dev\n\temail = dev@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n",
    )
    .unwrap();
    let base = [
        ("HOME", home.to_str().unwrap()),
        ("GIT_CONFIG_GLOBAL", global.to_str().unwrap()),
    ];
    git(&repo, &base, &["init", "-b", "main"]).unwrap();
    let hook = repo.join(".git").join("hooks").join("prepare-commit-msg");
    fs::write(&hook, "#!/bin/sh\nprintf 'Repo-Ran: yes\\n' >> \"$1\"\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&hook).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&hook, perms).unwrap();
    }
    let data = scratch.path().join("data dir");
    fs::create_dir_all(&data).unwrap();
    let hooks = super::hooks::install_hooks(&data).unwrap();
    let hooks_path = hooks.to_str().unwrap();
    let (count, key, value_name) = super::logic::git_config_env(None, hooks_path).unwrap();
    let hooks_owned = hooks_path.to_string();
    let mut crew = base.to_vec();
    crew.push(("HIVRA_CHAT", "chat-1"));
    crew.push(("HIVRA_TASK", "task-1"));
    crew.push(("GIT_CONFIG_COUNT", count.as_str()));
    crew.push((key.as_str(), "core.hooksPath"));
    crew.push((value_name.as_str(), hooks_owned.as_str()));
    let config_before = fs::read(repo.join(".git").join("config")).unwrap();
    fs::write(
        repo.join("note.txt"),
        "export function uniqueWidgetName42()\n",
    )
    .unwrap();
    git(&repo, &crew, &["add", "note.txt"]).unwrap();
    git(&repo, &crew, &["commit", "-m", "Stamp the trailer"]).unwrap();
    let body = git(&repo, &base, &["log", "-1", "--format=%B"]).unwrap();
    assert_eq!(
        body.lines()
            .filter(|line| line.starts_with("Hivra-Chat:"))
            .collect::<Vec<_>>(),
        vec!["Hivra-Chat: chat-1"]
    );
    assert_eq!(
        body.lines()
            .filter(|line| line.starts_with("Hivra-Task:"))
            .collect::<Vec<_>>(),
        vec!["Hivra-Task: task-1"]
    );
    assert!(body.contains("Repo-Ran: yes"));
    assert_eq!(
        fs::read(repo.join(".git").join("config")).unwrap(),
        config_before
    );
    assert!(git(
        &repo,
        &base,
        &["config", "--local", "--get", "core.hooksPath"]
    )
    .is_err());
}

#[test]
fn a_person_committing_agent_lines_is_inferred_and_a_plain_commit_keeps_counts() {
    let scratch = Scratch::new();
    let repo = scratch.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    let home = scratch.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let global = scratch.path().join("gitconfig");
    fs::write(
        &global,
        "[user]\n\tname = Dev\n\temail = dev@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n",
    )
    .unwrap();
    let env = [
        ("HOME", home.to_str().unwrap()),
        ("GIT_CONFIG_GLOBAL", global.to_str().unwrap()),
    ];
    git(&repo, &env, &["init", "-b", "main"]).unwrap();
    fs::write(repo.join("keep.txt"), "base\n").unwrap();
    git(&repo, &env, &["add", "keep.txt"]).unwrap();
    git(&repo, &env, &["commit", "-m", "base"]).unwrap();

    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "INSERT INTO delegations (id, owner_session, root_id, child_session, request_id, state, delivery, created_at, updated_at)
         VALUES ('d1', 'owner', 'd1', 'chat-1', 'r1', 'running', 'pr', 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tasks (id, project_id, number, title, status_id, sort_key, source, created_by, assignee, delegation_id, created_at, updated_at)
         VALUES ('task-1', 'p', 1, 'Fix the gate', 's', 'a', 'test', 'ash', 'Ada', 'd1', 1, 2)",
        [],
    )
    .unwrap();
    drop(conn);
    let lines = [
        "export function uniqueWidgetName42()",
        "return the unique widget now",
    ];
    let hashes: Vec<String> = lines
        .iter()
        .map(|line| super::logic::hash_line(line))
        .collect();
    let top = crate::fs::canonical(&repo).unwrap();
    super::remember_lines(&store, &top, "chat-1", &hashes).unwrap();

    fs::write(
        repo.join("agent.txt"),
        format!("{}\n{{\nimport fs from \"fs\";\n", lines.join("\n")),
    )
    .unwrap();
    git(&repo, &env, &["add", "agent.txt"]).unwrap();
    git(
        &repo,
        &env,
        &["commit", "-m", "by hand\n\nsk-ant-api03-SECRETVALUE"],
    )
    .unwrap();
    let inferred = super::refresh(&store, &repo, None).unwrap();
    let found = inferred
        .iter()
        .find(|credit| credit.subject.as_deref() == Some("by hand"))
        .unwrap();
    assert_eq!(found.tier, "inferred");
    assert_eq!(found.chat_id.as_deref(), Some("chat-1"));
    assert_eq!(found.task_id.as_deref(), Some("task-1"));
    assert_eq!(found.agent.as_deref(), Some("Ada"));

    fs::write(repo.join("plain.txt"), "{\nimport fs from \"fs\";\n").unwrap();
    git(&repo, &env, &["add", "plain.txt"]).unwrap();
    git(
        &repo,
        &env,
        &["commit", "-m", "mine\n\nsk-ant-api03-SECRETVALUE"],
    )
    .unwrap();
    fs::write(repo.join("own.txt"), "a person wrote this line\n").unwrap();
    git(&repo, &env, &["add", "own.txt"]).unwrap();
    git(
        &repo,
        &env,
        &["commit", "-m", "only me\n\nsk-ant-api03-SECRETVALUE"],
    )
    .unwrap();
    let scanned = super::refresh(&store, &repo, None).unwrap();
    let plain = scanned
        .iter()
        .find(|credit| credit.file_count >= 1 && credit.tier == "person")
        .unwrap();
    assert!(plain.subject.is_none());
    assert!(plain.chat_id.is_none());
    assert!(plain.line_count >= 1);

    let conn = store.lock_conn().unwrap();
    let dumped: String = conn
        .query_row(
            "SELECT group_concat(COALESCE(subject, '') || COALESCE(agent, '') || COALESCE(chat_id, ''), ',') FROM attribution_commits",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap()
        .unwrap_or_default();
    let activity: String = conn
        .query_row(
            "SELECT group_concat(summary, ',') FROM activity",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap()
        .unwrap_or_default();
    assert!(!dumped.contains("SECRETVALUE"), "{dumped}");
    assert!(!activity.contains("SECRETVALUE"), "{activity}");
    assert!(activity.contains("commit by Ada for Fix the gate"));
}
