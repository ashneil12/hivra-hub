use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

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
        overlap: 0,
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

struct GitRepo {
    repo: PathBuf,
    home: PathBuf,
    global: PathBuf,
}

impl GitRepo {
    fn new(scratch: &Scratch) -> Self {
        let repo = scratch.path().join("repo");
        let home = scratch.path().join("home");
        let global = scratch.path().join("gitconfig");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(
            &global,
            "[user]\n\tname = Dev\n\temail = dev@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n",
        )
        .unwrap();
        Self { repo, home, global }
    }

    fn env(&self) -> [(&str, &str); 2] {
        [
            ("HOME", self.home.to_str().unwrap()),
            ("GIT_CONFIG_GLOBAL", self.global.to_str().unwrap()),
        ]
    }
}

#[test]
fn opening_a_task_keeps_a_commit_outside_the_newest_page() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &made.env(), &["add", "keep.txt"]).unwrap();
    git(&made.repo, &made.env(), &["commit", "-m", "base"]).unwrap();
    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    let top = super::git::toplevel(&made.repo).unwrap();
    let key = top.to_str().unwrap();
    let old = "0123456789abcdef0123456789abcdef01234567";
    store_credit(
        &store,
        key,
        row(old, Tier::Confirmed, Some("chat-1"), Some("task-1")),
    )
    .unwrap();
    let shown = super::credits_for_task(&store, "task-1", made.repo.to_str()).unwrap();
    assert!(
        shown.iter().any(|credit| credit.sha == old
            && credit.task_id.as_deref() == Some("task-1")
            && credit.tier == "confirmed"),
        "{shown:?}"
    );
    let missing = scratch.path().join("missing");
    fs::write(&missing, "nope").unwrap();
    let kept = super::credits_for_task(&store, "task-1", missing.to_str()).unwrap();
    assert!(kept.iter().any(|credit| credit.sha == old));
}

#[test]
fn two_crews_do_not_share_one_hook_temp_file() {
    let dir = Path::new("hooks");
    assert_ne!(super::hooks::hook_temp(dir), super::hooks::hook_temp(dir));
}

#[test]
fn two_crews_installing_together_both_get_the_hook() {
    let scratch = Scratch::new();
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    for _ in 0..8 {
        let dest = data
            .join("attribution")
            .join("hooks")
            .join("prepare-commit-msg");
        let _ = fs::remove_file(&dest);
        let left = data.clone();
        let right = data.clone();
        let a = std::thread::spawn(move || {
            let mut cmd = Command::new("git");
            super::apply_crew_env(&mut cmd, &left, "chat-1", Some("task-1"));
            cmd.get_envs().any(|(key, _)| key == "GIT_CONFIG_COUNT")
        });
        let b = std::thread::spawn(move || {
            let mut cmd = Command::new("git");
            super::apply_crew_env(&mut cmd, &right, "chat-2", Some("task-2"));
            cmd.get_envs().any(|(key, _)| key == "GIT_CONFIG_COUNT")
        });
        assert!(a.join().unwrap());
        assert!(b.join().unwrap());
    }
    let script = fs::read_to_string(
        data.join("attribution")
            .join("hooks")
            .join("prepare-commit-msg"),
    )
    .unwrap();
    assert!(script.contains("Hivra-Chat:"));
}

#[test]
fn a_repo_with_no_commit_still_hashes_new_lines() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let line = "export function uniqueWidgetName42()";
    fs::write(made.repo.join("note.txt"), format!("{line}\n")).unwrap();
    let dirty = super::git::dirty_hashes(&made.repo).unwrap();
    let hashed = super::logic::hash_line(line);
    assert!(dirty.hashes.contains(&hashed));
    let again = super::lines_before_run(&made.repo).unwrap();
    assert!(again.contains(&hashed));
}

#[test]
fn a_timed_out_snapshot_is_read_again() {
    let hits = AtomicUsize::new(0);
    let got = super::read_with_retry(|| {
        if hits.fetch_add(1, Ordering::SeqCst) == 0 {
            Err("git didn't answer".into())
        } else {
            Ok(5)
        }
    })
    .unwrap();
    assert_eq!(got, 5);
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

#[test]
fn a_failed_activity_insert_is_retried_on_the_next_write() {
    let scratch = Scratch::new();
    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "CREATE TRIGGER fail_git_commit BEFORE INSERT ON activity
         WHEN NEW.kind = 'git.commit'
         BEGIN
           SELECT RAISE(ABORT, 'busy');
         END",
        [],
    )
    .unwrap();
    drop(conn);
    let inferred = row("abc1234", Tier::Inferred, Some("chat-1"), Some("task-1"));
    store_credit(&store, "repo-a", inferred.clone()).unwrap();
    assert_eq!(activity_count(&store), 0);
    let conn = store.lock_conn().unwrap();
    conn.execute("DROP TRIGGER fail_git_commit", []).unwrap();
    drop(conn);
    store_credit(&store, "repo-a", inferred).unwrap();
    assert_eq!(activity_count(&store), 1);
}

#[test]
fn a_later_stronger_journal_replaces_the_inferred_chat() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &made.env(), &["add", "keep.txt"]).unwrap();
    git(&made.repo, &made.env(), &["commit", "-m", "base"]).unwrap();
    let lines = [
        "export function uniqueWidgetName42()",
        "return the unique widget now",
        "compute the western azimuth today",
        "hold the final lattice open",
    ];
    fs::write(
        made.repo.join("agent.txt"),
        format!("{}\n", lines.join("\n")),
    )
    .unwrap();
    git(&made.repo, &made.env(), &["add", "agent.txt"]).unwrap();
    git(&made.repo, &made.env(), &["commit", "-m", "by hand"]).unwrap();
    let sha = git(&made.repo, &made.env(), &["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_string();
    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    let top = super::git::toplevel(&made.repo).unwrap();
    let key = top.to_str().unwrap().to_string();
    let hashes: Vec<String> = lines
        .iter()
        .map(|line| super::logic::hash_line(line))
        .collect();
    let conn = store.lock_conn().unwrap();
    for (index, hash) in hashes.iter().enumerate() {
        if index < 2 {
            conn.execute(
                "INSERT INTO attribution_journal (line_hash, chat_id, task_id, agent, repo, run_id, at)
                 VALUES (?1, 'chat-a', 'task-a', 'Ada', ?2, 'run-a', 1)",
                [hash, &key],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO attribution_journal (line_hash, chat_id, task_id, agent, repo, run_id, at)
             VALUES (?1, 'chat-b', 'task-b', 'Nia', ?2, 'run-b', 2)",
            [hash, &key],
        )
        .unwrap();
    }
    drop(conn);
    // Only A's lines are visible for the first pass. Hide B, then put it back.
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "DELETE FROM attribution_journal WHERE chat_id = 'chat-b'",
        [],
    )
    .unwrap();
    drop(conn);
    let first = super::refresh(&store, &made.repo, None).unwrap();
    let found = first.iter().find(|credit| credit.sha == sha).unwrap();
    assert_eq!(found.tier, "inferred");
    assert_eq!(found.chat_id.as_deref(), Some("chat-a"));
    let conn = store.lock_conn().unwrap();
    for hash in &hashes {
        conn.execute(
            "INSERT INTO attribution_journal (line_hash, chat_id, task_id, agent, repo, run_id, at)
             VALUES (?1, 'chat-b', 'task-b', 'Nia', ?2, 'run-b', 2)",
            [hash, &key],
        )
        .unwrap();
    }
    drop(conn);
    let second = super::refresh(&store, &made.repo, None).unwrap();
    let found = second.iter().find(|credit| credit.sha == sha).unwrap();
    assert_eq!(found.chat_id.as_deref(), Some("chat-b"), "{found:?}");
    let mut stale = row(&sha, Tier::Inferred, Some("chat-a"), Some("task-a"));
    stale.overlap = 2;
    stale.agent = Some("Ada".into());
    store_credit(&store, &key, stale).unwrap();
    let conn = store.lock_conn().unwrap();
    let chat: String = conn
        .query_row(
            "SELECT chat_id FROM attribution_commits WHERE sha = ?1",
            [&sha],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(chat, "chat-b");
    let latest: String = conn
        .query_row(
            "SELECT summary FROM activity WHERE kind = 'git.commit' ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(latest.contains("Nia"), "{latest}");
}

#[test]
fn an_older_ledger_gains_its_columns_in_place() {
    let scratch = Scratch::new();
    let store = SessionStore::open(scratch.path().join("ledger.db")).unwrap();
    let conn = store.lock_conn().unwrap();
    conn.execute_batch(
        "DROP TABLE attribution_commits;
         CREATE TABLE attribution_commits (
           sha TEXT NOT NULL,
           repo TEXT NOT NULL,
           tier TEXT NOT NULL CHECK (tier IN ('confirmed', 'inferred', 'person')),
           chat_id TEXT,
           task_id TEXT,
           agent TEXT,
           file_count INTEGER NOT NULL,
           line_count INTEGER NOT NULL,
           subject TEXT,
           at INTEGER NOT NULL,
           PRIMARY KEY (repo, sha)
         );
         INSERT INTO attribution_commits
           (sha, repo, tier, chat_id, task_id, agent, file_count, line_count, subject, at)
         VALUES ('person1', 'repo-a', 'person', NULL, NULL, NULL, 1, 1, NULL, 1);
         INSERT INTO attribution_commits
           (sha, repo, tier, chat_id, task_id, agent, file_count, line_count, subject, at)
         VALUES ('infer1', 'repo-a', 'inferred', 'chat-1', 'task-1', 'Ada', 1, 1, 's', 1);
         INSERT INTO attribution_commits
           (sha, repo, tier, chat_id, task_id, agent, file_count, line_count, subject, at)
         VALUES ('infer2', 'repo-a', 'inferred', 'chat-2', 'task-2', 'Nia', 1, 1, 's', 1);
         INSERT INTO activity (
           id, kind, actor_role, actor_id, actor_name,
           initiator_role, initiator_id, initiator_name,
           project, target, summary, link, at
         ) VALUES (
           'id-infer1', 'git.commit', 'worker', 'chat-1', 'Ada',
           'worker', 'chat-1', 'Ada',
           'repo-a', 'infer1', 'commit by Ada', 'session:chat-1', 1
         );",
    )
    .unwrap();
    super::ensure_tables(&conn).unwrap();
    let mut stmt = conn
        .prepare("SELECT sha, logged, overlap FROM attribution_commits ORDER BY sha")
        .unwrap();
    let rows: Vec<(String, i64, i64)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(stmt);
    assert_eq!(
        rows,
        vec![
            ("infer1".into(), 1, 0),
            ("infer2".into(), 0, 0),
            ("person1".into(), 1, 0),
        ]
    );
    assert_eq!(crate::session_store::schema_version(&conn).unwrap(), 19);
    assert_eq!(crate::session_store::SCHEMA_VERSION, 19);
}

/// Every name githooks(5) documents. A missing file is a repo hook that
/// silently stops firing while a crew's git is pointed at this folder.
const GITHOOKS: &[&str] = &[
    "applypatch-msg",
    "commit-msg",
    "fsmonitor-watchman",
    "p4-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
    "p4-prepare-changelist",
    "post-applypatch",
    "post-checkout",
    "post-commit",
    "post-index-change",
    "post-merge",
    "post-receive",
    "post-rewrite",
    "post-update",
    "pre-applypatch",
    "pre-auto-gc",
    "pre-commit",
    "pre-merge-commit",
    "pre-push",
    "pre-rebase",
    "pre-receive",
    "prepare-commit-msg",
    "proc-receive",
    "push-to-checkout",
    "reference-transaction",
    "sendemail-validate",
    "update",
];

fn mark_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).unwrap();
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn write_hook(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let script = if body.starts_with("#!") {
        body.to_string()
    } else {
        format!("#!/bin/sh\n{body}")
    };
    fs::write(path, script.replace("\r\n", "\n")).unwrap();
    mark_executable(path);
}

fn sh_quote(path: &Path) -> String {
    let text = path.to_str().unwrap();
    assert!(
        !text.contains('\''),
        "hook path cannot be quoted safely: {text}"
    );
    format!("'{text}'")
}

struct Armed {
    count: String,
    key: String,
    value_name: String,
    hooks_path: String,
}

fn arm(data: &Path) -> Armed {
    fs::create_dir_all(data).unwrap();
    let hooks = super::hooks::install_hooks(data).unwrap();
    let hooks_path = hooks.to_str().unwrap().to_string();
    let (count, key, value_name) = super::logic::git_config_env(None, &hooks_path).unwrap();
    Armed {
        count,
        key,
        value_name,
        hooks_path,
    }
}

fn crew_pairs<'a>(base: &[(&'a str, &'a str)], armed: &'a Armed) -> Vec<(&'a str, &'a str)> {
    let mut crew = base.to_vec();
    crew.push(("HIVRA_CHAT", "chat-1"));
    crew.push(("HIVRA_TASK", "task-1"));
    crew.push(("GIT_CONFIG_COUNT", armed.count.as_str()));
    crew.push((armed.key.as_str(), "core.hooksPath"));
    crew.push((armed.value_name.as_str(), armed.hooks_path.as_str()));
    crew
}

fn git_reading_system(repo: &Path, env: &[(&str, &str)], args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::delivery::child("git");
    cmd.arg("--no-pager").arg("-C").arg(repo).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    for (key, value) in env {
        cmd.env(key, value);
    }
    super::git::run_limited(cmd, std::time::Duration::from_secs(20))
        .map_err(|_| "git didn't answer".to_string())
}

#[test]
fn every_githooks_name_is_installed() {
    let scratch = Scratch::new();
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let dir = super::hooks::install_hooks(&data).unwrap();
    for name in GITHOOKS {
        let path = dir.join(name);
        assert!(path.is_file(), "missing hook {name}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "{name} is not executable");
        }
    }
}

#[test]
fn a_failing_pre_commit_blocks_a_crew_commit() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let head = git(&made.repo, &base, &["rev-parse", "HEAD"]).unwrap();
    let ran = scratch.path().join("pre-commit-ran");
    write_hook(
        &made.repo.join(".git").join("hooks").join("pre-commit"),
        &format!("printf 'ran\\n' > {}\nexit 1\n", sh_quote(&ran)),
    );
    let armed = arm(&scratch.path().join("data"));
    let crew = crew_pairs(&base, &armed);
    let config_before = fs::read(made.repo.join(".git").join("config")).unwrap();
    let global_before = fs::read(&made.global).unwrap();
    fs::write(made.repo.join("next.txt"), "next\n").unwrap();
    git(&made.repo, &crew, &["add", "next.txt"]).unwrap();
    assert!(git(&made.repo, &crew, &["commit", "-m", "should not land"]).is_err());
    assert!(ran.is_file(), "the repo pre-commit did not run");
    assert_eq!(
        git(&made.repo, &base, &["rev-parse", "HEAD"]).unwrap(),
        head
    );
    assert_eq!(
        fs::read(made.repo.join(".git").join("config")).unwrap(),
        config_before
    );
    assert_eq!(fs::read(&made.global).unwrap(), global_before);
}

#[test]
fn a_husky_repo_runs_pre_commit_and_commit_msg() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();

    let husky = made.repo.join(".husky").join("_");
    let pre = scratch.path().join("husky-pre");
    let msg = scratch.path().join("husky-msg");
    write_hook(
        &husky.join("pre-commit"),
        &format!("printf 'pre\\n' > {}\n", sh_quote(&pre)),
    );
    write_hook(
        &husky.join("commit-msg"),
        &format!(
            "printf 'Husky-Msg: yes\\n' >> \"$1\"\nprintf 'msg\\n' > {}\n",
            sh_quote(&msg)
        ),
    );
    let decoy = scratch.path().join("decoy-ran");
    write_hook(
        &made.repo.join(".git").join("hooks").join("pre-commit"),
        &format!("printf 'decoy\\n' > {}\nexit 1\n", sh_quote(&decoy)),
    );
    let global_hooks = scratch.path().join("global hooks");
    fs::create_dir_all(&global_hooks).unwrap();
    let global_ran = scratch.path().join("global-ran");
    write_hook(
        &global_hooks.join("pre-commit"),
        &format!("printf 'global\\n' > {}\n", sh_quote(&global_ran)),
    );
    git(
        &made.repo,
        &base,
        &[
            "config",
            "--global",
            "core.hooksPath",
            global_hooks.to_str().unwrap(),
        ],
    )
    .unwrap();
    git(&made.repo, &base, &["config", "core.hooksPath", ".husky/_"]).unwrap();

    let armed = arm(&scratch.path().join("data dir"));
    let crew = crew_pairs(&base, &armed);
    let config_before = fs::read(made.repo.join(".git").join("config")).unwrap();
    let global_before = fs::read(&made.global).unwrap();
    fs::write(made.repo.join("note.txt"), "husky note\n").unwrap();
    git(&made.repo, &crew, &["add", "note.txt"]).unwrap();
    git(&made.repo, &crew, &["commit", "-m", "through husky"]).unwrap();

    assert!(pre.is_file(), "husky pre-commit did not run");
    assert!(msg.is_file(), "husky commit-msg did not run");
    assert!(!decoy.exists(), "the common-dir hook ran instead of husky");
    assert!(
        !global_ran.exists(),
        "the global hooks path beat the local one"
    );
    let body = git(&made.repo, &base, &["log", "-1", "--format=%B"]).unwrap();
    assert!(body.contains("Hivra-Chat: chat-1"), "{body}");
    assert!(body.contains("Hivra-Task: task-1"), "{body}");
    assert!(body.contains("Husky-Msg: yes"), "{body}");
    assert_eq!(
        fs::read(made.repo.join(".git").join("config")).unwrap(),
        config_before
    );
    assert_eq!(fs::read(&made.global).unwrap(), global_before);
    assert!(
        git(
            &made.repo,
            &base,
            &["config", "--local", "--get", "core.hooksPath"]
        )
        .unwrap()
        .trim()
        .ends_with(".husky/_")
            || git(
                &made.repo,
                &base,
                &["config", "--local", "--get", "core.hooksPath"]
            )
            .unwrap()
            .trim()
                == ".husky/_"
    );
}

#[test]
fn a_global_hooks_path_is_used_when_the_repo_sets_none() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let hooks = scratch.path().join("hook dir");
    fs::create_dir_all(&hooks).unwrap();
    let ran = scratch.path().join("global-pre");
    write_hook(
        &hooks.join("pre-commit"),
        &format!("printf 'global\\n' > {}\n", sh_quote(&ran)),
    );
    git(
        &made.repo,
        &base,
        &[
            "config",
            "--global",
            "core.hooksPath",
            hooks.to_str().unwrap(),
        ],
    )
    .unwrap();
    let armed = arm(&scratch.path().join("data"));
    let crew = crew_pairs(&base, &armed);
    let config_before = fs::read(made.repo.join(".git").join("config")).unwrap();
    fs::write(made.repo.join("note.txt"), "note\n").unwrap();
    git(&made.repo, &crew, &["add", "note.txt"]).unwrap();
    git(&made.repo, &crew, &["commit", "-m", "via global hooks"]).unwrap();
    assert!(ran.is_file(), "the global hooks path was not used");
    let body = git(&made.repo, &base, &["log", "-1", "--format=%B"]).unwrap();
    assert!(body.contains("Hivra-Chat: chat-1"), "{body}");
    assert_eq!(
        fs::read(made.repo.join(".git").join("config")).unwrap(),
        config_before
    );
}

#[test]
fn a_system_hooks_path_is_used_when_nothing_closer_sets_one() {
    let scratch = Scratch::new();
    let repo = scratch.path().join("repo");
    let home = scratch.path().join("home");
    let global = scratch.path().join("gitconfig");
    let system = scratch.path().join("system-gitconfig");
    fs::create_dir_all(&repo).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(
        &global,
        "[user]\n\tname = Dev\n\temail = dev@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n",
    )
    .unwrap();
    fs::write(&system, "[core]\n\tautocrlf = false\n").unwrap();
    let base = [
        ("HOME", home.to_str().unwrap()),
        ("GIT_CONFIG_GLOBAL", global.to_str().unwrap()),
        ("GIT_CONFIG_SYSTEM", system.to_str().unwrap()),
    ];
    git_reading_system(&repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(repo.join("keep.txt"), "base\n").unwrap();
    git_reading_system(&repo, &base, &["add", "keep.txt"]).unwrap();
    git_reading_system(&repo, &base, &["commit", "-m", "base"]).unwrap();
    let hooks = scratch.path().join("system hooks");
    fs::create_dir_all(&hooks).unwrap();
    let ran = scratch.path().join("system-pre");
    write_hook(
        &hooks.join("pre-commit"),
        &format!("printf 'system\\n' > {}\n", sh_quote(&ran)),
    );
    let hooks_text = hooks.to_str().unwrap().replace('\\', "/");
    fs::write(
        &system,
        format!("[core]\n\tautocrlf = false\n\thooksPath = \"{hooks_text}\"\n"),
    )
    .unwrap();
    let armed = arm(&scratch.path().join("data"));
    let crew = crew_pairs(&base, &armed);
    let config_before = fs::read(repo.join(".git").join("config")).unwrap();
    let system_before = fs::read(&system).unwrap();
    fs::write(repo.join("note.txt"), "note\n").unwrap();
    git_reading_system(&repo, &crew, &["add", "note.txt"]).unwrap();
    git_reading_system(&repo, &crew, &["commit", "-m", "via system hooks"]).unwrap();
    assert!(ran.is_file(), "the system hooks path was not used");
    let body = git_reading_system(&repo, &base, &["log", "-1", "--format=%B"]).unwrap();
    assert!(body.contains("Hivra-Chat: chat-1"), "{body}");
    assert!(body.contains("Hivra-Task: task-1"), "{body}");
    assert_eq!(
        fs::read(repo.join(".git").join("config")).unwrap(),
        config_before
    );
    assert_eq!(fs::read(&system).unwrap(), system_before);
}

#[test]
fn pre_push_is_forwarded_with_stdin_args_and_exit_code() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let bare = scratch.path().join("bare.git");
    git(
        &made.repo,
        &base,
        &["init", "--bare", "-b", "main", bare.to_str().unwrap()],
    )
    .unwrap();
    git(
        &made.repo,
        &base,
        &["remote", "add", "origin", bare.to_str().unwrap()],
    )
    .unwrap();
    let stdin_path = scratch.path().join("pre-push-stdin");
    let args_path = scratch.path().join("pre-push-args");
    write_hook(
        &made.repo.join(".git").join("hooks").join("pre-push"),
        &format!(
            "printf '%s\\n' \"$1\" \"$2\" > {}\ncat > {}\nexit 1\n",
            sh_quote(&args_path),
            sh_quote(&stdin_path)
        ),
    );
    let armed = arm(&scratch.path().join("data"));
    let crew = crew_pairs(&base, &armed);
    let config_before = fs::read(made.repo.join(".git").join("config")).unwrap();
    assert!(git(&made.repo, &crew, &["push", "origin", "HEAD"]).is_err());
    let stdin_text = fs::read_to_string(&stdin_path).unwrap_or_default();
    assert!(
        stdin_text.contains("refs/"),
        "pre-push stdin was not forwarded: {stdin_text:?}"
    );
    let args_text = fs::read_to_string(&args_path).unwrap_or_default();
    let mut lines = args_text.lines();
    assert_eq!(lines.next(), Some("origin"), "{args_text}");
    let url = lines.next().unwrap_or("");
    assert!(url.contains("bare.git"), "{args_text}");
    assert_eq!(
        fs::read(made.repo.join(".git").join("config")).unwrap(),
        config_before
    );
}

#[test]
fn a_worktree_commit_runs_the_common_dir_pre_commit() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let ran = scratch.path().join("common-pre");
    write_hook(
        &made.repo.join(".git").join("hooks").join("pre-commit"),
        &format!("printf 'common\\n' > {}\nexit 1\n", sh_quote(&ran)),
    );
    let wt = scratch.path().join("wt dir");
    git(
        &made.repo,
        &base,
        &["worktree", "add", "-b", "feature", wt.to_str().unwrap()],
    )
    .unwrap();
    let head = git(&wt, &base, &["rev-parse", "HEAD"]).unwrap();
    let armed = arm(&scratch.path().join("data"));
    let crew = crew_pairs(&base, &armed);
    fs::write(wt.join("next.txt"), "next\n").unwrap();
    git(&wt, &crew, &["add", "next.txt"]).unwrap();
    assert!(git(&wt, &crew, &["commit", "-m", "from the worktree"]).is_err());
    assert!(
        ran.is_file(),
        "the common dir hook did not run for the worktree"
    );
    assert_eq!(git(&wt, &base, &["rev-parse", "HEAD"]).unwrap(), head);
}

#[test]
fn the_repo_prepare_commit_msg_runs_before_the_trailers() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    write_hook(
        &made
            .repo
            .join(".git")
            .join("hooks")
            .join("prepare-commit-msg"),
        "printf 'rewritten by repo\\n' > \"$1\"\n",
    );
    let armed = arm(&scratch.path().join("data"));
    let crew = crew_pairs(&base, &armed);
    let config_before = fs::read(made.repo.join(".git").join("config")).unwrap();
    fs::write(made.repo.join("note.txt"), "note\n").unwrap();
    git(&made.repo, &crew, &["add", "note.txt"]).unwrap();
    git(&made.repo, &crew, &["commit", "-m", "will be rewritten"]).unwrap();
    let body = git(&made.repo, &base, &["log", "-1", "--format=%B"]).unwrap();
    assert!(body.contains("rewritten by repo"), "{body}");
    assert!(body.contains("Hivra-Chat: chat-1"), "{body}");
    assert!(body.contains("Hivra-Task: task-1"), "{body}");
    let chat_at = body.find("Hivra-Chat:").unwrap();
    let rewritten_at = body.find("rewritten by repo").unwrap();
    assert!(
        rewritten_at < chat_at,
        "trailers were stamped before the repo hook rewrote the message: {body}"
    );
    assert_eq!(
        fs::read(made.repo.join(".git").join("config")).unwrap(),
        config_before
    );
}

#[cfg(unix)]
#[test]
fn a_non_executable_pre_commit_does_not_block() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let ran = scratch.path().join("disabled-ran");
    let hook = made.repo.join(".git").join("hooks").join("pre-commit");
    fs::write(
        &hook,
        format!("#!/bin/sh\nprintf 'ran\\n' > {}\nexit 1\n", sh_quote(&ran)),
    )
    .unwrap();
    let mut perms = fs::metadata(&hook).unwrap().permissions();
    perms.set_mode(0o644);
    fs::set_permissions(&hook, perms).unwrap();
    let armed = arm(&scratch.path().join("data"));
    let crew = crew_pairs(&base, &armed);
    fs::write(made.repo.join("next.txt"), "next\n").unwrap();
    git(&made.repo, &crew, &["add", "next.txt"]).unwrap();
    git(&made.repo, &crew, &["commit", "-m", "past a disabled hook"]).unwrap();
    assert!(!ran.exists(), "a non-executable hook ran");
    let body = git(&made.repo, &base, &["log", "-1", "--format=%B"]).unwrap();
    assert!(body.contains("Hivra-Chat: chat-1"), "{body}");
}
