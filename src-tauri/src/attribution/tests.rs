use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

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
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let first = scratch.path().join("data a");
    let second = scratch.path().join("data b");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let env = env_pairs(&made.env());
    let hooks_a = super::hooks::install_for_repo(&first, &made.repo, &env).unwrap();
    let hooks_b = super::hooks::install_for_repo(&second, &made.repo, &env).unwrap();
    let root_a = crate::fs::canonical(&first).unwrap();
    let root_b = crate::fs::canonical(&second).unwrap();
    assert!(hooks_a.starts_with(&root_a));
    assert!(hooks_b.starts_with(&root_b));
    assert_ne!(hooks_a, hooks_b);
    let attribution_a = root_a.join("attribution");
    assert_eq!(
        hooks_a.parent().and_then(Path::parent),
        Some(attribution_a.as_path())
    );
    let script = fs::read(hooks_a.join("prepare-commit-msg")).unwrap();
    assert_eq!(
        script,
        fs::read(hooks_b.join("prepare-commit-msg")).unwrap()
    );
    assert!(std::str::from_utf8(&script)
        .unwrap()
        .contains("Hivra-Chat:"));
    let again = super::hooks::install_for_repo(&first, &made.repo, &env).unwrap();
    assert_eq!(again, hooks_a);
    assert_eq!(fs::read(again.join("prepare-commit-msg")).unwrap(), script);
}

/// The folder is named after the repository's common git dir, so every
/// worktree of one repository shares it and two repositories do not.
#[test]
fn one_folder_per_repository() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let wt = scratch.path().join("wt");
    git(
        &made.repo,
        &base,
        &["worktree", "add", "-b", "side", wt.to_str().unwrap()],
    )
    .unwrap();
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let from_main = super::hooks::install_for_repo(&data, &made.repo, &env_pairs(&base)).unwrap();
    let from_worktree = super::hooks::install_for_repo(&data, &wt, &env_pairs(&base)).unwrap();
    assert_eq!(from_main, from_worktree);
    let other = scratch.path().join("other");
    fs::create_dir_all(&other).unwrap();
    git(&other, &base, &["init", "-b", "main"]).unwrap();
    let from_other = super::hooks::install_for_repo(&data, &other, &env_pairs(&base)).unwrap();
    assert_ne!(from_main, from_other);
    assert!(from_main.starts_with(crate::fs::canonical(&data).unwrap()));
    assert!(from_other.starts_with(crate::fs::canonical(&data).unwrap()));
}

#[cfg(unix)]
#[test]
fn a_hook_symlink_is_not_followed() {
    use std::os::unix::fs::symlink;
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let dir = super::hooks::install_for_repo(&data, &made.repo, &env_pairs(&made.env())).unwrap();
    let outside = scratch.path().join("outside.txt");
    fs::write(&outside, "keep").unwrap();
    let dest = dir.join("prepare-commit-msg");
    fs::remove_file(&dest).unwrap();
    symlink(&outside, &dest).unwrap();
    assert!(super::hooks::install_for_repo(&data, &made.repo, &env_pairs(&made.env())).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
}

#[cfg(windows)]
#[test]
fn a_hook_that_is_not_a_file_is_refused() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let dir = super::hooks::install_for_repo(&data, &made.repo, &env_pairs(&made.env())).unwrap();
    let outside = scratch.path().join("outside.txt");
    fs::write(&outside, "keep").unwrap();
    let dest = dir.join("prepare-commit-msg");
    fs::remove_file(&dest).unwrap();
    fs::create_dir(&dest).unwrap();
    assert!(super::hooks::install_for_repo(&data, &made.repo, &env_pairs(&made.env())).is_err());
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
    let mut cmd = crate::git_cmd::child_keep_hooks();
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
    let armed = arm(&scratch.path().join("data dir"), &repo, &base);
    let crew = crew_pairs(&base, &armed);
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

/// The name test and the name maker must not drift apart: prune trusts the
/// first to recognise what the second is writing right now.
#[test]
fn every_hook_temp_name_is_recognised_as_one() {
    let dir = Path::new("hooks");
    for _ in 0..8 {
        let temp = super::hooks::hook_temp(dir);
        let name = temp.file_name().unwrap().to_str().unwrap();
        assert!(super::hooks::is_hook_temp(name), "not recognised: {name}");
    }
    // A near miss is not one: the test has to be exact, or prune would spare a
    // real file that happens to sit in the folder.
    for name in [
        "prepare-commit-msg",
        ".prepare-commit-msg.tmp",
        ".prepare-commit-msg.12.tmp",
        ".prepare-commit-msg.12.3.tmp.bak",
        "prepare-commit-msg.12.3.tmp",
        ".prepare-commit-msg..3.tmp",
        ".prepare-commit-msg.12..tmp",
        ".prepare-commit-msg.12.3.4.tmp",
        ".prepare-commit-msg.12.3.tmpx",
        ".prepare-commit-msg.12a.3.tmp",
    ] {
        assert!(
            !super::hooks::is_hook_temp(name),
            "wrongly recognised: {name}"
        );
    }
}

/// A temp name can never be a hook name. Without this, a file the repository
/// owns could be mistaken for somebody's half-written temp file and skipped.
#[test]
fn a_temp_name_is_never_a_hook_name() {
    let dir = Path::new("hooks");
    for _ in 0..8 {
        let temp = super::hooks::hook_temp(dir);
        let name = temp.file_name().unwrap().to_str().unwrap();
        assert!(
            !super::hooks::hook_name_ok(name),
            "claimed as a hook: {name}"
        );
    }
}

/// A data dir and the hooks folder inside it, both canonical, for prune.
fn hooks_folder(scratch: &Scratch) -> (PathBuf, PathBuf) {
    let root = scratch.path().join("data");
    let dir = root.join("attribution").join("hooks").join("repo");
    fs::create_dir_all(&dir).unwrap();
    (
        crate::fs::canonical(&root).unwrap(),
        crate::fs::canonical(&dir).unwrap(),
    )
}

fn keep_set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| (*name).to_string()).collect()
}

/// Write a file and stamp its modified time, so a test never has to sleep. The
/// handle is dropped before the caller uses the file: a live handle would only
/// change the answer on Windows, which is the platform these tests must hold on.
fn write_at(path: &Path, when: SystemTime, body: &str) {
    fs::write(path, body).unwrap();
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(when))
        .unwrap();
    drop(file);
}

/// Write a file and age it.
fn write_aged(path: &Path, age: Duration, body: &str) {
    write_at(path, SystemTime::now() - age, body);
}

/// Just past the grace, so the file counts as a crashed crew's leftover.
fn past_the_grace() -> Duration {
    super::hooks::TEMP_GRACE + Duration::from_secs(60)
}

/// Two crews install into one folder at the same time. Whichever prunes must
/// leave the other's temp file alone, or the other's publish fails.
#[test]
fn a_fresh_temp_file_survives_prune() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let temp = super::hooks::hook_temp(&dir);
    write_aged(&temp, Duration::ZERO, "#!/bin/sh\n");
    super::hooks::prune(&root, &dir, &keep_set(&["prepare-commit-msg"])).unwrap();
    assert!(temp.exists(), "prune removed another crew's live temp file");
}

/// A crew that died mid-install leaves its temp file behind. Once nobody can
/// still be writing it, the next install clears it away.
#[test]
fn a_stale_temp_file_is_removed_by_prune() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let temp = super::hooks::hook_temp(&dir);
    write_aged(&temp, past_the_grace(), "#!/bin/sh\n");
    super::hooks::prune(&root, &dir, &keep_set(&["prepare-commit-msg"])).unwrap();
    assert!(!temp.exists(), "a crashed crew's temp file was left behind");
}

/// The grace is for temp names only. A forwarder for a hook the repository no
/// longer has goes, however recently it was written.
#[test]
fn a_forwarder_not_in_keep_is_removed_fresh_or_stale() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let fresh = dir.join("pre-commit");
    let stale = dir.join("commit-msg");
    write_aged(&fresh, Duration::ZERO, "#!/bin/sh\n");
    write_aged(&stale, past_the_grace(), "#!/bin/sh\n");
    super::hooks::prune(&root, &dir, &keep_set(&["prepare-commit-msg"])).unwrap();
    assert!(!fresh.exists(), "a fresh forwarder not in keep was kept");
    assert!(!stale.exists(), "a stale forwarder not in keep was kept");
}

/// What the folder holds that is not in keep is still off limits.
#[test]
fn a_hook_in_keep_is_never_removed() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let kept = dir.join("prepare-commit-msg");
    write_aged(&kept, past_the_grace(), "#!/bin/sh\n");
    super::hooks::prune(&root, &dir, &keep_set(&["prepare-commit-msg"])).unwrap();
    assert!(kept.exists(), "prune removed a hook it was told to keep");
}

/// Windows refuses to remove a file another crew has open, or has deleted but
/// not yet closed, with PermissionDenied rather than NotFound. A temp file is
/// disposable, so that must not fail the whole install.
#[test]
fn a_temp_file_that_cannot_be_removed_does_not_refuse() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let temp = super::hooks::hook_temp(&dir);
    write_aged(&temp, past_the_grace(), "#!/bin/sh\n");
    let mut tried = 0;
    let result = super::hooks::prune_with(&root, &dir, &keep_set(&["prepare-commit-msg"]), |_| {
        tried += 1;
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    });
    assert!(
        result.is_ok(),
        "a stuck temp file refused the install: {result:?}"
    );
    assert_eq!(
        tried, 1,
        "the removal was never attempted, so this proves nothing"
    );
}

/// Every way a temp file's removal can fail is skipped, not just
/// PermissionDenied. Windows refuses a file another process holds open with
/// ERROR_SHARING_VIOLATION (os error 32), and Rust does not map that to
/// PermissionDenied (only ERROR_ACCESS_DENIED, os error 5, is mapped), so a
/// sharing violation arrives as some other kind. A rule that named only
/// PermissionDenied would not cover the case it was written for.
#[test]
fn any_error_on_a_temp_file_does_not_refuse() {
    let sharing_violation = std::io::Error::from_raw_os_error(32).kind();
    for kind in [
        std::io::ErrorKind::PermissionDenied,
        sharing_violation,
        std::io::ErrorKind::Other,
    ] {
        let scratch = Scratch::new();
        let (root, dir) = hooks_folder(&scratch);
        let temp = super::hooks::hook_temp(&dir);
        write_aged(&temp, past_the_grace(), "#!/bin/sh\n");
        let mut tried = 0;
        let result =
            super::hooks::prune_with(&root, &dir, &keep_set(&["prepare-commit-msg"]), |_| {
                tried += 1;
                Err(std::io::Error::from(kind))
            });
        assert!(
            result.is_ok(),
            "a {kind:?} on a temp file refused the install: {result:?}"
        );
        assert_eq!(tried, 1, "the removal was never attempted ({kind:?})");
    }
}

/// Any other error on a real hook file refuses, not only PermissionDenied.
#[test]
fn another_error_on_a_forwarder_still_refuses() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    write_aged(&dir.join("pre-commit"), Duration::ZERO, "#!/bin/sh\n");
    let result = super::hooks::prune_with(&root, &dir, &keep_set(&["prepare-commit-msg"]), |_| {
        Err(std::io::Error::from(std::io::ErrorKind::Other))
    });
    assert!(
        result.is_err(),
        "a failed removal of a real hook was swallowed: {result:?}"
    );
}

/// The grace is measured from the temp file's own age, with the cut at
/// TEMP_GRACE. Wide margins, so a slow runner cannot flip either side.
#[test]
fn the_grace_boundary_is_the_temp_file_s_own_age() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let young = super::hooks::hook_temp(&dir);
    let old = super::hooks::hook_temp(&dir);
    write_aged(
        &young,
        super::hooks::TEMP_GRACE - Duration::from_secs(30),
        "#!/bin/sh\n",
    );
    write_aged(
        &old,
        super::hooks::TEMP_GRACE + Duration::from_secs(30),
        "#!/bin/sh\n",
    );
    super::hooks::prune(&root, &dir, &keep_set(&["prepare-commit-msg"])).unwrap();
    assert!(young.exists(), "a temp file inside the grace was removed");
    assert!(!old.exists(), "a temp file past the grace was kept");
}

/// A clock step can leave a temp file stamped in the future. That has to read
/// as fresh: removing a live crew's temp file is the failure being fixed here.
#[test]
fn a_temp_file_stamped_in_the_future_is_treated_as_fresh() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let temp = super::hooks::hook_temp(&dir);
    write_at(
        &temp,
        SystemTime::now() + Duration::from_secs(120),
        "#!/bin/sh\n",
    );
    super::hooks::prune(&root, &dir, &keep_set(&["prepare-commit-msg"])).unwrap();
    assert!(temp.exists(), "a future-stamped temp file was removed");
}

/// Removing a link removes the link, never what it points at.
#[cfg(unix)]
#[test]
fn prune_removes_a_link_without_touching_its_target() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let target = scratch.path().join("real-pre-commit");
    fs::write(&target, "#!/bin/sh\necho real\n").unwrap();
    let link = dir.join("pre-commit");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    super::hooks::prune(&root, &dir, &keep_set(&["prepare-commit-msg"])).unwrap();
    assert!(!link.exists(), "the link was left behind");
    assert!(
        target.exists(),
        "prune followed the link and removed its target"
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "#!/bin/sh\necho real\n"
    );
}

/// A real hook file whose removal fails is an error we must not swallow: the
/// folder would keep a forwarder for a hook the repository no longer has.
#[test]
fn a_forwarder_that_cannot_be_removed_still_refuses() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    write_aged(&dir.join("pre-commit"), Duration::ZERO, "#!/bin/sh\n");
    let result = super::hooks::prune_with(&root, &dir, &keep_set(&["prepare-commit-msg"]), |_| {
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    });
    assert!(
        result.is_err(),
        "a failed removal of a real hook was swallowed: {result:?}"
    );
}

/// The other crew removed it between the listing and the removal. That is not
/// an error, on any platform.
#[test]
fn a_file_that_is_already_gone_does_not_refuse() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    write_aged(&dir.join("pre-commit"), Duration::ZERO, "#!/bin/sh\n");
    let result = super::hooks::prune_with(&root, &dir, &keep_set(&["prepare-commit-msg"]), |_| {
        Err(std::io::Error::from(std::io::ErrorKind::NotFound))
    });
    assert!(
        result.is_ok(),
        "a lost race refused the install: {result:?}"
    );
}

/// A write to the temp file can fail on Windows while another crew holds or is
/// deleting that name. The next attempt writes a new one rather than failing
/// the whole crew.
#[test]
fn a_failed_publish_write_retries_with_a_new_temp_name() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let dest = dir.join("prepare-commit-msg");
    let script = "#!/bin/sh\n# retry\n";
    let mut tries = 0;
    let result = super::hooks::publish_hook_with(&root, &dir, &dest, script, |hooks| {
        tries += 1;
        if tries == 1 {
            // A name whose folder does not exist: the write fails the way a
            // sharing violation fails it, without a Windows machine.
            hooks.join("missing").join("first.tmp")
        } else {
            super::hooks::hook_temp(hooks)
        }
    });
    assert!(
        result.is_ok(),
        "the second attempt should have published: {result:?}"
    );
    assert!(tries >= 2, "it did not retry with a new temp file");
    assert_eq!(fs::read_to_string(&dest).unwrap(), script);
}

/// A link planted at the temp name must be refused, never written through:
/// following it would overwrite whatever it points at.
#[cfg(unix)]
#[test]
fn a_link_at_the_temp_name_is_refused() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let outside = scratch.path().join("outside.txt");
    fs::write(&outside, "not mine\n").unwrap();
    let temp = super::hooks::hook_temp(&dir);
    std::os::unix::fs::symlink(&outside, &temp).unwrap();
    let dest = dir.join("prepare-commit-msg");
    let result =
        super::hooks::publish_hook_with(&root, &dir, &dest, "#!/bin/sh\n", |_| temp.clone());
    assert!(result.is_err(), "a planted link was followed: {result:?}");
    assert!(!dest.exists(), "it published through the link anyway");
    assert_eq!(
        fs::read_to_string(&outside).unwrap(),
        "not mine\n",
        "the link's target was overwritten"
    );
}

/// The retry must not become a way round the containment check: a temp name
/// outside the data folder is refused on every attempt.
#[test]
fn a_temp_name_outside_the_data_folder_is_refused_on_every_attempt() {
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let outside = scratch.path().join("outside.tmp");
    fs::write(&outside, "not mine\n").unwrap();
    let dest = dir.join("prepare-commit-msg");
    let mut tries = 0;
    let result = super::hooks::publish_hook_with(&root, &dir, &dest, "#!/bin/sh\n", |_| {
        tries += 1;
        outside.clone()
    });
    assert!(
        result.is_err(),
        "an outside temp name was published: {result:?}"
    );
    assert_eq!(
        tries, 1,
        "the containment check did not stop the first attempt"
    );
    assert!(!dest.exists(), "it published from outside the data folder");
    assert_eq!(fs::read_to_string(&outside).unwrap(), "not mine\n");
}

#[test]
fn two_crews_installing_together_both_get_the_hook() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let env = env_pairs(&made.env());
    for round in 0..8 {
        let left = data.clone();
        let right = data.clone();
        let repo_a = made.repo.clone();
        let repo_b = made.repo.clone();
        let env_a = env.clone();
        let env_b = env.clone();
        let home_a = made.home.clone();
        let home_b = made.home.clone();
        let global_a = made.global.clone();
        let global_b = made.global.clone();
        let a = std::thread::spawn(move || {
            let installed = super::hooks::install_for_repo(&left, &repo_a, &env_a);
            let mut cmd = crate::git_cmd::git_keep_hooks();
            cmd.env("HOME", &home_a).env("GIT_CONFIG_GLOBAL", &global_a);
            super::apply_crew_env(&mut cmd, &left, &repo_a, "chat-1", Some("task-1"));
            let pointed = cmd.get_envs().any(|(key, _)| key == "GIT_CONFIG_COUNT");
            (installed, pointed)
        });
        let b = std::thread::spawn(move || {
            let installed = super::hooks::install_for_repo(&right, &repo_b, &env_b);
            let mut cmd = crate::git_cmd::git_keep_hooks();
            cmd.env("HOME", &home_b).env("GIT_CONFIG_GLOBAL", &global_b);
            super::apply_crew_env(&mut cmd, &right, &repo_b, "chat-2", Some("task-2"));
            let pointed = cmd.get_envs().any(|(key, _)| key == "GIT_CONFIG_COUNT");
            (installed, pointed)
        });
        let (from_a, pointed_a) = a.join().unwrap();
        let (from_b, pointed_b) = b.join().unwrap();
        assert!(from_a.is_ok(), "round {round}, crew a: {from_a:?}");
        assert!(from_b.is_ok(), "round {round}, crew b: {from_b:?}");
        assert_eq!(from_a.unwrap(), from_b.unwrap(), "round {round}");
        assert!(pointed_a, "round {round}, crew a got no hooksPath");
        assert!(pointed_b, "round {round}, crew b got no hooksPath");
    }
    let hooks_root = data.join("attribution").join("hooks");
    let dirs: Vec<PathBuf> = fs::read_dir(&hooks_root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(dirs.len(), 1, "one folder per repository: {dirs:?}");
    let script = fs::read_to_string(dirs[0].join("prepare-commit-msg")).unwrap();
    assert!(script.starts_with("#!/bin/sh"));
    assert!(script.contains("Hivra-Chat:"));
    assert!(script.trim_end().ends_with("exit 0"));
}

// The hooks folder when two crews install at once on Windows. The race itself
// only happens there, so these play Windows' answers back on any platform and
// check the pieces: which errors are worth another try, that the retry is
// bounded and never reaches a containment decision, and that every refusal
// says which check it was.

fn os_error(code: i32) -> std::io::Error {
    std::io::Error::from_raw_os_error(code)
}

/// The Win32 numbers by name.
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PATH_NOT_FOUND: i32 = 3;
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;
const ERROR_BAD_NETPATH: i32 = 53;
const ERROR_BAD_NET_NAME: i32 = 67;
const ERROR_INVALID_PARAMETER: i32 = 87;
const ERROR_ALREADY_EXISTS: i32 = 183;

#[test]
fn only_busy_windows_errors_are_transient() {
    use super::hooks::is_transient;
    for code in [
        ERROR_ACCESS_DENIED,
        ERROR_SHARING_VIOLATION,
        ERROR_LOCK_VIOLATION,
    ] {
        for mid_create in [false, true] {
            assert!(
                is_transient(&os_error(code), true, mid_create),
                "os error {code} is another process holding the file on Windows"
            );
            // The same numbers are EIO, EPIPE and EDOM on Unix: a real failure.
            assert!(
                !is_transient(&os_error(code), false, mid_create),
                "os error {code} was retried off Windows"
            );
        }
    }
    // Rust maps 53 and 67 to NotFound too, and Windows says "nothing there"
    // with 2 and 3 only: the others are a share that is gone, not a folder
    // another crew has not finished making.
    for code in [
        1,
        ERROR_BAD_NETPATH,
        ERROR_BAD_NET_NAME,
        123,
        267,
        ERROR_INVALID_PARAMETER,
        ERROR_ALREADY_EXISTS,
    ] {
        for windows in [false, true] {
            for mid_create in [false, true] {
                assert!(
                    !is_transient(&os_error(code), windows, mid_create),
                    "os error {code} is not a busy file (windows {windows}, mid_create {mid_create})"
                );
            }
        }
    }
    for code in [ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND] {
        assert!(
            is_transient(&os_error(code), true, true),
            "os error {code} while the other crew is mid-create is worth a retry"
        );
        assert!(
            !is_transient(&os_error(code), true, false),
            "os error {code} for a path that was never seen is not mid-create"
        );
        assert!(
            !is_transient(&os_error(code), false, true),
            "nothing makes a path appear later on Unix"
        );
    }
    // A kind with no OS number is not classified by guessing.
    for kind in [
        std::io::ErrorKind::NotFound,
        std::io::ErrorKind::PermissionDenied,
    ] {
        let bare: std::io::Error = kind.into();
        assert!(!is_transient(&bare, true, true), "{kind:?}");
    }
}

/// What Windows answers a crew that loses the race to make a folder: the
/// create is refused as busy and the look that follows does not see the folder
/// yet. The first try used to turn that into a refusal.
#[test]
fn a_folder_the_other_crew_is_making_is_waited_for_on_windows() {
    use super::hooks::{ensure_child_with, Call, Fs};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let root = crate::fs::canonical(scratch.path()).unwrap();
    let (creates, looks) = (Cell::new(0), Cell::new(0));
    let mut fault = |call: Call, _: &Path| match call {
        Call::Create => {
            creates.set(creates.get() + 1);
            (creates.get() == 1).then(|| os_error(ERROR_ACCESS_DENIED))
        }
        Call::Stat => {
            looks.set(looks.get() + 1);
            (looks.get() == 2).then(|| os_error(ERROR_ACCESS_DENIED))
        }
        _ => None,
    };
    let made = ensure_child_with(
        &mut Fs::playing(true, &mut fault),
        &root,
        "attribution",
        "attribution",
    );
    let made = made.unwrap_or_else(|err| panic!("the loser of the race was refused: {err}"));
    assert!(made.is_dir());
    assert_eq!(creates.get(), 2, "it did not go round again");
}

/// The same answers off Windows are a real failure, and stop at the first try:
/// this is what every platform did before.
#[test]
fn the_same_answers_off_windows_are_not_retried() {
    use super::hooks::{ensure_child_with, Call, Fs, REFUSAL};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let root = crate::fs::canonical(scratch.path()).unwrap();
    let creates = Cell::new(0);
    let mut fault = |call: Call, _: &Path| match call {
        Call::Create => {
            creates.set(creates.get() + 1);
            Some(os_error(ERROR_ACCESS_DENIED))
        }
        _ => None,
    };
    let refused = ensure_child_with(
        &mut Fs::playing(false, &mut fault),
        &root,
        "attribution",
        "attribution",
    )
    .unwrap_err();
    assert!(refused.starts_with(REFUSAL), "{refused}");
    assert!(refused.contains("attribution: create"), "{refused}");
    assert!(
        refused.contains(&format!("os error {ERROR_ACCESS_DENIED}")),
        "{refused}"
    );
    assert_eq!(creates.get(), 1, "it retried off Windows");
}

/// The other crew made the folder, and the look that follows does not see it
/// for a moment. "Already exists" then "not found" cannot both be true, so it
/// looks again.
#[test]
fn a_folder_that_exists_but_is_not_visible_yet_is_waited_for() {
    use super::hooks::{ensure_child_with, Call, Fs};
    use std::cell::Cell;
    for windows in [true, false] {
        let scratch = Scratch::new();
        let root = crate::fs::canonical(scratch.path()).unwrap();
        let looks = Cell::new(0);
        let mut fault = |call: Call, path: &Path| match call {
            Call::Create => {
                // The other crew's create, which the first try lost to.
                let _ = fs::create_dir(path);
                Some(std::io::ErrorKind::AlreadyExists.into())
            }
            Call::Stat => {
                looks.set(looks.get() + 1);
                // The first look is before the create; the next two come after
                // it and do not see what the other crew made.
                (looks.get() == 2 || looks.get() == 3).then(|| {
                    if windows {
                        os_error(ERROR_FILE_NOT_FOUND)
                    } else {
                        std::io::ErrorKind::NotFound.into()
                    }
                })
            }
            _ => None,
        };
        let made = ensure_child_with(
            &mut Fs::playing(windows, &mut fault),
            &root,
            "attribution",
            "attribution",
        );
        assert!(made.is_ok(), "windows {windows}: {made:?}");
    }
}

/// A link or a file in the way is a containment answer, not a busy one: it is
/// refused on the first look with no create and no second look, even where
/// the busy errors are retried. So is a path that leaves the data folder.
#[test]
fn a_real_containment_failure_is_never_retried() {
    use super::hooks::{ensure_child_with, Call, Fs, REFUSAL};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let root = crate::fs::canonical(scratch.path()).unwrap();
    fs::write(root.join("afile"), "x").unwrap();
    #[cfg(unix)]
    {
        let elsewhere = scratch.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("alink")).unwrap();
    }
    let outside = std::env::temp_dir().join("hivra-elsewhere");
    let outside = outside.to_str().unwrap();
    // `mut` is only used where the link case below exists.
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut cases = vec![
        ("afile", "afile: is not a folder", 1),
        (outside, "afile: path leaves the data folder", 0),
        ("..", "afile: not a folder name", 0),
    ];
    #[cfg(unix)]
    cases.push(("alink", "afile: is a link", 1));
    for (rel, expect, looks_expected) in cases {
        let calls = Cell::new(0);
        let mut fault = |_: Call, _: &Path| {
            calls.set(calls.get() + 1);
            None
        };
        let refused =
            ensure_child_with(&mut Fs::playing(true, &mut fault), &root, rel, "afile").unwrap_err();
        assert!(refused.starts_with(REFUSAL), "{refused}");
        assert!(refused.contains(expect), "{rel}: {refused}");
        assert_eq!(
            calls.get(),
            looks_expected,
            "{rel}: it went on after the refusal"
        );
    }
}

/// "Not found" right after a create is only the other crew's folder not showing
/// up yet when the create said the folder exists or was refused as busy. A
/// create that failed for any other reason (the parent is missing, a real
/// denial, a bad name) followed by "not found" is a real failure, and it stops
/// at the first try even where busy errors are retried.
#[test]
fn a_create_that_failed_for_another_reason_is_not_retried() {
    use super::hooks::{ensure_child_with, Call, Fs, REFUSAL};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let root = crate::fs::canonical(scratch.path()).unwrap();
    let failures: Vec<Box<dyn Fn() -> std::io::Error>> = vec![
        Box::new(|| std::io::ErrorKind::NotFound.into()),
        Box::new(|| std::io::ErrorKind::PermissionDenied.into()),
        // A missing parent, as Windows says it.
        Box::new(|| os_error(ERROR_PATH_NOT_FOUND)),
        Box::new(|| os_error(ERROR_BAD_NETPATH)),
        Box::new(|| os_error(ERROR_INVALID_PARAMETER)),
    ];
    for failure in failures {
        let creates = Cell::new(0);
        let mut fault = |call: Call, _: &Path| match call {
            Call::Create => {
                creates.set(creates.get() + 1);
                Some(failure())
            }
            // Nothing is there, and the look says so every time.
            Call::Stat => Some(os_error(ERROR_FILE_NOT_FOUND)),
            _ => None,
        };
        let refused = ensure_child_with(
            &mut Fs::playing(true, &mut fault),
            &root,
            "attribution",
            "attribution",
        )
        .unwrap_err();
        assert!(refused.starts_with(REFUSAL), "{refused}");
        assert!(refused.contains("attribution: create"), "{refused}");
        assert_eq!(creates.get(), 1, "a real failure was retried: {refused}");
    }
}

/// A call that stays busy is tried a fixed number of times and then fails with
/// the error it got; one that is not busy is not tried again at all.
#[test]
fn the_retry_is_bounded_and_ignores_other_errors() {
    use super::hooks::{ensure_child_with, Call, Fs, FS_TRIES};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let root = crate::fs::canonical(scratch.path()).unwrap();
    fs::create_dir(root.join("attribution")).unwrap();
    for (code, tries) in [
        (ERROR_SHARING_VIOLATION, FS_TRIES),
        (ERROR_LOCK_VIOLATION, FS_TRIES),
        (ERROR_ACCESS_DENIED, FS_TRIES),
        (ERROR_INVALID_PARAMETER, 1),
    ] {
        let resolves = Cell::new(0);
        let mut fault = |call: Call, _: &Path| match call {
            Call::Resolve => {
                resolves.set(resolves.get() + 1);
                Some(os_error(code))
            }
            _ => None,
        };
        let refused = ensure_child_with(
            &mut Fs::playing(true, &mut fault),
            &root,
            "attribution",
            "attribution",
        )
        .unwrap_err();
        assert!(refused.contains("attribution: resolve"), "{refused}");
        assert!(refused.contains(&format!("os error {code}")), "{refused}");
        assert_eq!(resolves.get(), tries, "os error {code}");
    }
}

/// A busy hook is waited out, both before it is replaced and after.
#[test]
fn a_busy_hook_is_waited_out_on_windows() {
    use super::hooks::{install_one_with, Call, Fs};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let script = "#!/bin/sh\n# busy\n";
    fs::write(dir.join("prepare-commit-msg"), "#!/bin/sh\n# old\n").unwrap();
    let (looks, resolves) = (Cell::new(0), Cell::new(0));
    let mut fault = |call: Call, _: &Path| match call {
        Call::Stat => {
            looks.set(looks.get() + 1);
            (looks.get() < 3).then(|| os_error(ERROR_SHARING_VIOLATION))
        }
        Call::Resolve => {
            resolves.set(resolves.get() + 1);
            (resolves.get() % 3 != 0).then(|| os_error(ERROR_ACCESS_DENIED))
        }
        _ => None,
    };
    let done = install_one_with(
        &mut Fs::playing(true, &mut fault),
        &root,
        &dir,
        "prepare-commit-msg",
        script,
    );
    assert!(done.is_ok(), "{done:?}");
    assert_eq!(
        fs::read_to_string(dir.join("prepare-commit-msg")).unwrap(),
        script
    );
    assert!(looks.get() >= 3 && resolves.get() >= 6);
}

/// The first publish is the one place only a fresh data folder reaches: both
/// crews write a temp file and move it over the hook at the same moment, and on
/// Windows the move is refused as busy while a scanner or the other crew holds
/// the file. The old wait was 2 ms between new temp files, which a loaded
/// machine outlasts; the busy move is now retried on the same file.
#[test]
fn a_busy_rename_is_waited_out_on_the_same_temp_file() {
    use super::hooks::{publish_hook_in, Call, Fs, FS_TRIES};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let dest = dir.join("prepare-commit-msg");
    let script = "#!/bin/sh\n# first publish\n";
    let (renames, temps) = (Cell::new(0), Cell::new(0));
    let mut fault = |call: Call, _: &Path| match call {
        Call::Rename => {
            renames.set(renames.get() + 1);
            (renames.get() < FS_TRIES).then(|| os_error(ERROR_SHARING_VIOLATION))
        }
        _ => None,
    };
    let published = publish_hook_in(
        &mut Fs::playing(true, &mut fault),
        &root,
        &dir,
        &dest,
        script,
        |hooks| {
            temps.set(temps.get() + 1);
            super::hooks::hook_temp(hooks)
        },
    );
    assert!(published.is_ok(), "{published:?}");
    assert_eq!(fs::read_to_string(&dest).unwrap(), script);
    assert_eq!(renames.get(), FS_TRIES, "it did not wait for the last try");
    assert_eq!(
        temps.get(),
        1,
        "it wrote a new temp file instead of waiting"
    );
}

/// A move that stays busy gives up after the same bounded number of tries per
/// temp file, and the refusal says what it hit last.
#[test]
fn a_rename_that_stays_busy_gives_up_and_says_so() {
    use super::hooks::{publish_hook_in, Call, Fs, FS_TRIES, REFUSAL};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let dest = dir.join("prepare-commit-msg");
    let renames = Cell::new(0);
    let mut fault = |call: Call, _: &Path| match call {
        Call::Rename => {
            renames.set(renames.get() + 1);
            Some(os_error(ERROR_ACCESS_DENIED))
        }
        _ => None,
    };
    let refused = publish_hook_in(
        &mut Fs::playing(true, &mut fault),
        &root,
        &dir,
        &dest,
        "#!/bin/sh\n",
        super::hooks::hook_temp,
    )
    .unwrap_err();
    assert!(refused.starts_with(REFUSAL), "{refused}");
    assert!(refused.contains("publish: gave up"), "{refused}");
    assert!(refused.contains("rename temp over the hook"), "{refused}");
    assert!(refused.contains("os error 5"), "{refused}");
    assert_eq!(
        renames.get(),
        8 * FS_TRIES as usize,
        "eight temp files, each tried FS_TRIES times"
    );
    assert!(!dest.exists());
    let left: Vec<_> = fs::read_dir(&dir).unwrap().collect();
    assert!(left.is_empty(), "temp files left behind: {left:?}");
}

/// If the other crew already published, a busy move has nothing to wait for.
#[test]
fn a_busy_rename_stops_waiting_when_the_other_crew_published() {
    use super::hooks::{publish_hook_in, Call, Fs};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let dest = dir.join("prepare-commit-msg");
    let script = "#!/bin/sh\n# other crew\n";
    fs::write(&dest, script).unwrap();
    let renames = Cell::new(0);
    let mut fault = |call: Call, _: &Path| match call {
        Call::Rename => {
            renames.set(renames.get() + 1);
            Some(os_error(ERROR_SHARING_VIOLATION))
        }
        _ => None,
    };
    let published = publish_hook_in(
        &mut Fs::playing(true, &mut fault),
        &root,
        &dir,
        &dest,
        script,
        super::hooks::hook_temp,
    );
    assert!(published.is_ok(), "{published:?}");
    assert_eq!(
        renames.get(),
        1,
        "it waited on a hook that was already right"
    );
}

/// A stale forwarder that Windows will not delete this instant (a handle on it,
/// or a delete another crew has pending) is deleted a moment later. Before, the
/// first busy answer failed the whole install.
#[test]
fn a_busy_stale_hook_is_removed_on_a_later_try_on_windows() {
    use super::hooks::{prune_in, Fs};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let stale = dir.join("pre-commit");
    write_aged(&stale, Duration::ZERO, "#!/bin/sh\n");
    let calls = Cell::new(0);
    let done = prune_in(
        &mut Fs::playing(true, &mut |_, _| None),
        &root,
        &dir,
        &keep_set(&["prepare-commit-msg"]),
        |path| {
            calls.set(calls.get() + 1);
            match calls.get() {
                1 => Err(os_error(ERROR_SHARING_VIOLATION)),
                2 => Err(os_error(ERROR_ACCESS_DENIED)),
                3 => Err(os_error(ERROR_LOCK_VIOLATION)),
                _ => fs::remove_file(path),
            }
        },
    );
    assert!(done.is_ok(), "{done:?}");
    assert_eq!(calls.get(), 4);
    assert!(!stale.exists(), "the stale hook was left in the folder");
}

/// A hook that stays busy is still a refusal, after the bounded tries, and the
/// refusal names the error. Off Windows, or for an error that is not busy, the
/// first answer is final, and a temp file is never waited for.
#[test]
fn a_stale_hook_that_stays_busy_is_refused_after_the_bounded_tries() {
    use super::hooks::{prune_in, Fs, FS_TRIES, REFUSAL};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    write_aged(&dir.join("pre-commit"), Duration::ZERO, "#!/bin/sh\n");
    let cases: [(bool, std::io::Error, u32); 4] = [
        (true, os_error(ERROR_SHARING_VIOLATION), FS_TRIES),
        (true, os_error(ERROR_INVALID_PARAMETER), 1),
        (true, std::io::ErrorKind::PermissionDenied.into(), 1),
        (false, os_error(ERROR_SHARING_VIOLATION), 1),
    ];
    for (windows, failure, tries) in cases {
        let calls = Cell::new(0u32);
        let code = failure.raw_os_error();
        let kind = failure.kind();
        let refused = prune_in(
            &mut Fs::playing(windows, &mut |_, _| None),
            &root,
            &dir,
            &keep_set(&["prepare-commit-msg"]),
            |_| {
                calls.set(calls.get() + 1);
                Err(match code {
                    Some(code) => os_error(code),
                    None => kind.into(),
                })
            },
        )
        .unwrap_err();
        assert!(refused.starts_with(REFUSAL), "{refused}");
        assert!(refused.contains("prune: remove a hook file"), "{refused}");
        assert_eq!(calls.get(), tries, "windows {windows}, {refused}");
    }
    // A stale temp file is disposable: never waited for, never a refusal.
    let temp = super::hooks::hook_temp(&dir);
    write_aged(&temp, Duration::from_secs(3600), "partial");
    fs::remove_file(dir.join("pre-commit")).unwrap();
    let calls = Cell::new(0u32);
    let done = prune_in(
        &mut Fs::playing(true, &mut |_, _| None),
        &root,
        &dir,
        &keep_set(&["prepare-commit-msg"]),
        |_| {
            calls.set(calls.get() + 1);
            Err(os_error(ERROR_SHARING_VIOLATION))
        },
    );
    assert!(done.is_ok(), "{done:?}");
    assert_eq!(calls.get(), 1, "a temp file was waited for");
}

/// An install that fails must not be silent: the crew still runs, so this line
/// is the only way a real Windows failure is ever seen. It carries the check
/// and the OS error and nothing from the environment or the repository.
#[test]
fn a_failed_install_is_noted_and_the_crew_still_runs() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let secret = "hunter2-do-not-log";
    let mut cmd = crate::git_cmd::git_keep_hooks();
    cmd.env("HOME", &made.home)
        .env("GIT_CONFIG_GLOBAL", &made.global)
        .env("GIT_CONFIG_KEY_0", secret);
    let gone = scratch.path().join("no-such-data-folder");
    let mut notes: Vec<String> = Vec::new();
    super::apply_crew_env_noting(
        &mut cmd,
        &gone,
        &made.repo,
        "chat-1",
        Some("task-1"),
        |line| notes.push(line),
    );
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].contains(super::hooks::REFUSAL), "{notes:?}");
    assert!(
        notes[0].contains("(check: data folder: resolve"),
        "{notes:?}"
    );
    assert!(
        !notes[0].contains(secret),
        "an env value was logged: {notes:?}"
    );
    let repo = made.repo.to_string_lossy();
    assert!(
        !notes[0].contains(repo.as_ref()),
        "a path was logged: {notes:?}"
    );
    assert!(
        !cmd.get_envs().any(|(key, _)| key == "GIT_CONFIG_COUNT"),
        "a failed install still pointed git at a hooks folder"
    );

    // A good install says nothing.
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let mut cmd = crate::git_cmd::git_keep_hooks();
    cmd.env("HOME", &made.home)
        .env("GIT_CONFIG_GLOBAL", &made.global);
    let mut quiet: Vec<String> = Vec::new();
    super::apply_crew_env_noting(
        &mut cmd,
        &data,
        &made.repo,
        "chat-1",
        Some("task-1"),
        |line| quiet.push(line),
    );
    assert!(quiet.is_empty(), "{quiet:?}");
    assert!(cmd.get_envs().any(|(key, _)| key == "GIT_CONFIG_COUNT"));
}

/// The failure Windows CI showed under eight crews: "hook: resolves outside the
/// data folder". Asking Windows for the path of a hook file means opening it,
/// and when another crew replaces the file at that moment the answer is the
/// name of the unlinked file, a folder under `$Extend`, which is outside the
/// data folder though nothing escaped. The hook is now checked by its folder,
/// which is never replaced, so no hook file is opened to learn its path.
#[test]
fn a_hook_replaced_while_it_is_checked_is_not_an_escape() {
    use super::hooks::{install_one_with, Fs};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let dest = dir.join("prepare-commit-msg");
    let stale = "#!/bin/sh\n# old\n";
    let script = "#!/bin/sh\n# replaced\n";
    let unlinked = root
        .parent()
        .unwrap()
        .join("$Extend")
        .join("$Deleted")
        .join("0000000000000a1f");
    for existing in [None, Some(stale), Some(script)] {
        let _ = fs::remove_file(&dest);
        if let Some(body) = existing {
            fs::write(&dest, body).unwrap();
        }
        let opened_a_file = Cell::new(false);
        let mut relabel = |asked: &Path, found: PathBuf| {
            if asked.is_file() {
                opened_a_file.set(true);
                unlinked.clone()
            } else {
                found
            }
        };
        let done = install_one_with(
            &mut Fs::relabeling(true, &mut relabel),
            &root,
            &dir,
            "prepare-commit-msg",
            script,
        );
        assert!(done.is_ok(), "hook before: {existing:?}: {done:?}");
        assert!(!opened_a_file.get(), "it opened a hook file for its path");
        assert_eq!(fs::read_to_string(&dest).unwrap(), script);
    }
}

/// A folder that really resolves outside the data folder is still refused on
/// the first look, before anything is written, and never retried.
#[cfg(unix)]
#[test]
fn a_hook_folder_that_resolves_outside_is_refused_at_once() {
    use super::hooks::{install_one_with, Call, Fs};
    use std::cell::Cell;
    let scratch = Scratch::new();
    let (root, _dir) = hooks_folder(&scratch);
    let elsewhere = scratch.path().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    let linked = root.join("linked-folder");
    std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
    let resolves = Cell::new(0);
    let mut fault = |call: Call, _: &Path| {
        if call == Call::Resolve {
            resolves.set(resolves.get() + 1);
        }
        None
    };
    let refused = install_one_with(
        &mut Fs::playing(true, &mut fault),
        &root,
        &linked,
        "prepare-commit-msg",
        "#!/bin/sh\n",
    )
    .unwrap_err();
    assert!(
        refused.contains("hook folder: resolves outside the data folder before publish"),
        "{refused}"
    );
    assert_eq!(resolves.get(), 1, "an escape was retried");
    assert_eq!(
        fs::read_dir(&elsewhere).unwrap().count(),
        0,
        "it wrote outside the data folder"
    );
}

/// A refusal for a path outside the data folder says what the path looks like
/// without printing it, so a Windows quirk reads differently from an escape.
#[test]
fn an_outside_path_is_described_without_being_printed() {
    use super::hooks::{ensure_child_with, Fs};
    let scratch = Scratch::new();
    let root = crate::fs::canonical(scratch.path()).unwrap();
    let cases = [
        (
            root.parent()
                .unwrap()
                .join("$Extend")
                .join("$Deleted")
                .join("1f"),
            "the name of an unlinked file",
        ),
        (
            PathBuf::from(root.to_string_lossy().to_uppercase()).join("attribution"),
            "the data folder in another case",
        ),
        // Beside the data folder, not in it: on Linux the scratch path is already canonical, so a child of it
        // would be inside.
        (root.parent().unwrap().join("elsewhere"), "elsewhere"),
    ];
    for (found, said) in cases {
        let mut relabel = |_: &Path, _: PathBuf| found.clone();
        let refused = ensure_child_with(
            &mut Fs::relabeling(true, &mut relabel),
            &root,
            "attribution",
            "attribution",
        )
        .unwrap_err();
        assert!(refused.contains(&format!("({said})")), "{said}: {refused}");
        assert!(
            !refused.contains(found.to_string_lossy().as_ref()),
            "the path was printed: {refused}"
        );
    }
}

/// Every refusal names its check, and no two checks say the same thing, so a
/// failure in CI says which one it was.
#[test]
fn every_refusal_says_which_check_failed() {
    use super::hooks::{ensure_child_with, install_one_with, Call, Fs, REFUSAL};
    let scratch = Scratch::new();
    let (root, dir) = hooks_folder(&scratch);
    let mut said: Vec<String> = Vec::new();
    let mut real = Fs::real();
    said.push(ensure_child_with(&mut real, &root, "..", "x").unwrap_err());
    let outside = std::env::temp_dir().join("hivra-elsewhere");
    said.push(ensure_child_with(&mut real, &root, outside.to_str().unwrap(), "x").unwrap_err());
    fs::write(root.join("afile"), "x").unwrap();
    said.push(ensure_child_with(&mut real, &root, "afile", "x").unwrap_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(scratch.path(), root.join("alink")).unwrap();
        said.push(ensure_child_with(&mut real, &root, "alink", "x").unwrap_err());
    }
    // The parent is not there, so the create fails and so does the look.
    said.push(ensure_child_with(&mut real, &root.join("gone"), "x", "x").unwrap_err());
    let mut resolve_fails = |call: Call, _: &Path| {
        (call == Call::Resolve).then(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))
    };
    said.push(
        ensure_child_with(
            &mut Fs::playing(false, &mut resolve_fails),
            &root,
            "attribution-less",
            "x",
        )
        .unwrap_err(),
    );
    said.push(install_one_with(&mut real, &root, &dir, "Bad Name", "s").unwrap_err());
    fs::create_dir(dir.join("pre-commit")).unwrap();
    said.push(install_one_with(&mut real, &root, &dir, "pre-commit", "s").unwrap_err());
    let dest = dir.join("prepare-commit-msg");
    said.push(
        super::hooks::publish_hook_with(&root, &dir, &dest, "s", |hooks| {
            hooks.join("missing").join("x.tmp")
        })
        .unwrap_err(),
    );
    said.push(
        super::hooks::publish_hook_with(&root, &dir, &dest, "s", |_| {
            scratch.path().join("outside.tmp")
        })
        .unwrap_err(),
    );
    said.push(
        super::hooks::prune_with(&root, &root.join("gone"), &keep_set(&[]), |_| Ok(()))
            .unwrap_err(),
    );
    fs::remove_dir(dir.join("pre-commit")).unwrap();
    write_aged(&dir.join("commit-msg"), Duration::ZERO, "#!/bin/sh\n");
    said.push(
        super::hooks::prune_with(&root, &dir, &keep_set(&["prepare-commit-msg"]), |_| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        })
        .unwrap_err(),
    );
    for text in &said {
        assert!(text.starts_with(REFUSAL), "{text}");
        assert!(text.contains("(check: "), "no check named: {text}");
    }
    let distinct: BTreeSet<&String> = said.iter().collect();
    assert_eq!(
        distinct.len(),
        said.len(),
        "two checks say the same thing: {said:#?}"
    );
}

/// Many crews starting together on a data folder with nothing in it: each
/// makes the three folders, publishes the hook and prunes, with the starting
/// gun the git calls give the two-crew test. Every one of them must get the
/// same folder and a complete hook, and a failure names the check.
#[test]
fn many_crews_installing_into_a_fresh_data_folder_all_get_the_hook() {
    use super::hooks::{ensure_child_with, install_one_with, Fs};
    use std::sync::{Arc, Barrier};
    let scratch = Scratch::new();
    let script = "#!/bin/sh\n# many crews\nexit 0\n";
    for round in 0..25 {
        let data = scratch.path().join(format!("data-{round}"));
        fs::create_dir_all(&data).unwrap();
        let root = crate::fs::canonical(&data).unwrap();
        let start = Arc::new(Barrier::new(8));
        let crews: Vec<_> = (0..8)
            .map(|_| {
                let root = root.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || -> Result<PathBuf, String> {
                    start.wait();
                    let mut fs = Fs::real();
                    let attribution =
                        ensure_child_with(&mut fs, &root, "attribution", "attribution")?;
                    let hooks = ensure_child_with(&mut fs, &attribution, "hooks", "hooks")?;
                    let dir = ensure_child_with(&mut fs, &hooks, "repo", "repo folder")?;
                    install_one_with(&mut fs, &root, &dir, "prepare-commit-msg", script)?;
                    super::hooks::prune(&root, &dir, &keep_set(&["prepare-commit-msg"]))?;
                    Ok(dir)
                })
            })
            .collect();
        let dirs: Vec<PathBuf> = crews
            .into_iter()
            .enumerate()
            .map(|(crew, handle)| {
                handle
                    .join()
                    .unwrap()
                    .unwrap_or_else(|err| panic!("round {round}, crew {crew}: {err}"))
            })
            .collect();
        assert!(
            dirs.windows(2).all(|pair| pair[0] == pair[1]),
            "round {round}"
        );
        assert_eq!(
            fs::read_to_string(dirs[0].join("prepare-commit-msg")).unwrap(),
            script,
            "round {round}"
        );
    }
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
    assert!(!dirty.truncated);
    let again = super::lines_before_run(&made.repo).unwrap();
    assert!(again.hashes.contains(&hashed));
    assert!(!again.truncated);
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
    assert_eq!(crate::session_store::schema_version(&conn).unwrap(), 21);
    assert_eq!(crate::session_store::SCHEMA_VERSION, 21);
}

/// Every name githooks(5) documents, except three that must not be files in
/// the crew folder. push-to-checkout: receive-pack hands it the worktree
/// update, so a forwarder that exits 0 moves the ref and leaves the files.
/// proc-receive: only when configured, and exit 0 does not speak its protocol.
/// fsmonitor-watchman: git never runs that name from the hooks directory.
const GITHOOKS: &[&str] = &[
    "applypatch-msg",
    "commit-msg",
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
    "reference-transaction",
    "sendemail-validate",
    "update",
];

/// Present, these change git or do nothing. They must not come back.
const HOOKS_NOT_INSTALLED: &[&str] = &["fsmonitor-watchman", "proc-receive", "push-to-checkout"];

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

fn env_pairs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

/// What the app does for one crew: resolve this repository's own hooks, write
/// this repository's folder, and return the environment that points git at it.
fn arm(data: &Path, repo: &Path, env: &[(&str, &str)]) -> Armed {
    fs::create_dir_all(data).unwrap();
    // The pre-push guard is the app's own binary; a test runs a stand-in that passes, and tests the guard itself elsewhere.
    let stand_in = data.join("guard-stand-in");
    write_hook(&stand_in, "exit 0\n");
    let hooks =
        super::hooks::install_for_repo_with(data, repo, &env_pairs(env), &stand_in).unwrap();
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
    let mut cmd = crate::git_cmd::child_keep_hooks();
    cmd.arg("--no-pager").arg("-C").arg(repo).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    for (key, value) in env {
        cmd.env(key, value);
    }
    super::git::run_limited(cmd, std::time::Duration::from_secs(20))
        .map_err(|_| "git didn't answer".to_string())
}

/// Git's own rule: the executable bit on Unix, existence on Windows.
fn hook_test() -> &'static str {
    if cfg!(windows) {
        "-f"
    } else {
        "-x"
    }
}

fn hook_test_line() -> &'static str {
    if cfg!(windows) {
        "hook_test='-f'"
    } else {
        "hook_test='-x'"
    }
}

/// Every executable hook the repository has at spawn gets a forwarder, and the
/// three names that would change git get none, even when the repository has them.
#[test]
fn every_executable_repo_hook_is_forwarded_and_three_are_never_written() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    let hooks = made.repo.join(".git").join("hooks");
    for name in GITHOOKS {
        write_hook(
            &hooks.join(name),
            &format!("printf '%s\\n' {name} >> \"$1\"\n"),
        );
    }
    for name in HOOKS_NOT_INSTALLED {
        write_hook(&hooks.join(name), "exit 1\n");
    }
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let dir = super::hooks::install_for_repo(&data, &made.repo, &env_pairs(&base)).unwrap();
    for name in GITHOOKS {
        let path = dir.join(name);
        assert!(path.is_file(), "missing hook {name}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "{name} is not executable");
        }
        let text = fs::read_to_string(&path).unwrap();
        if *name == "prepare-commit-msg" {
            assert!(
                text.contains("Hivra-Chat:"),
                "prepare is not the stamping script"
            );
            assert!(
                !text.contains("real_hook=''"),
                "prepare did not bake the repository's own hook"
            );
            assert!(
                text.contains(hook_test_line()),
                "{name} has the wrong hook test: {text}"
            );
        } else if *name == "pre-commit" {
            // WP-248: the pre-commit hook runs the commit guard first, stops on its refusal, then the repository's own.
            assert!(
                text.contains("pre-commit-guard --store"),
                "pre-commit does not run the guard: {text}"
            );
            assert!(
                text.contains("|| exit 1") && text.contains("exec \"$real_hook\" \"$@\""),
                "pre-commit does not stop on a refusal and then forward: {text}"
            );
            assert!(
                !text.contains("real_hook=''"),
                "pre-commit did not bake the repository's own hook: {text}"
            );
        } else if *name == "pre-push" {
            // WP-200: the pre-push hook runs the commit guard first, then the repository's own hook.
            assert!(
                text.contains("pre-push-guard"),
                "pre-push does not run the guard: {text}"
            );
            assert!(
                text.contains("\"$real_hook\" \"$@\" < \"$refs\""),
                "pre-push does not forward to the repository's hook with the ref list: {text}"
            );
        } else {
            assert!(
                text.contains("exec \"$real_hook\" \"$@\""),
                "{name} is not a forwarder: {text}"
            );
            assert!(
                text.contains(&format!("if [ {test} \"$real_hook\" ]", test = hook_test())),
                "{name} has the wrong hook test: {text}"
            );
        }
        assert!(!text.contains('\r'), "{name} must use LF line endings");
    }
    for name in HOOKS_NOT_INSTALLED {
        assert!(!dir.join(name).exists(), "{name} must not be installed");
    }
}

#[test]
fn a_repo_with_no_hooks_gets_only_prepare_commit_msg() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let dir = super::hooks::install_for_repo(&data, &made.repo, &env_pairs(&base)).unwrap();
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    // WP-200: the pre-push hook (the commit guard) is installed too, even with no repository hook of its own; WP-248:
    // so is the pre-commit hook, which runs the same check before a commit is made.
    assert_eq!(
        names,
        vec![
            "pre-commit".to_string(),
            "pre-push".to_string(),
            "prepare-commit-msg".to_string()
        ]
    );
    let script = fs::read_to_string(dir.join("prepare-commit-msg")).unwrap();
    assert!(script.contains("real_hook=''"));
    assert!(script.contains("Hivra-Chat:"));
    assert!(script.contains(hook_test_line()));
    assert!(!script.contains('\r'), "the hook must use LF line endings");
}

/// The folder is rebuilt at each spawn, so a hook that appears during a run is
/// not picked up by that run. It is forwarded from the next one.
#[test]
fn a_hook_added_after_the_crew_starts_is_picked_up_on_the_next_run() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let data = scratch.path().join("data");
    let first = arm(&data, &made.repo, &base);
    let crew = crew_pairs(&base, &first);
    let ran = scratch.path().join("late-pre-commit");
    write_hook(
        &made.repo.join(".git").join("hooks").join("pre-commit"),
        &format!("printf 'ran\\n' > {}\nexit 1\n", sh_quote(&ran)),
    );
    fs::write(made.repo.join("note.txt"), "note\n").unwrap();
    git(&made.repo, &crew, &["add", "note.txt"]).unwrap();
    git(&made.repo, &crew, &["commit", "-m", "before the next run"]).unwrap();
    assert!(
        !ran.exists(),
        "a hook added mid-run ran without a new spawn"
    );

    let second = arm(&data, &made.repo, &base);
    let crew = crew_pairs(&base, &second);
    fs::write(made.repo.join("next.txt"), "next\n").unwrap();
    git(&made.repo, &crew, &["add", "next.txt"]).unwrap();
    assert!(git(&made.repo, &crew, &["commit", "-m", "blocked once"]).is_err());
    assert!(ran.is_file(), "the new hook did not run on the next spawn");
}

/// The hook starts no git of its own. A PATH shim records any call; the
/// repository hook and the trailers must still run around it.
#[cfg(unix)]
// Runs the hook through `sh`, so it is a unix test.
#[cfg(unix)]
#[test]
fn a_forwarder_makes_no_git_calls() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    let ran = scratch.path().join("repo-hook-ran");
    write_hook(
        &made
            .repo
            .join(".git")
            .join("hooks")
            .join("prepare-commit-msg"),
        &format!(
            "printf 'Repo-Ran: yes\\n' >> \"$1\"\nprintf 'ran\\n' > {}\n",
            sh_quote(&ran)
        ),
    );
    let armed = arm(&scratch.path().join("data"), &made.repo, &base);
    let crew = crew_pairs(&base, &armed);
    let shim = scratch.path().join("shim");
    fs::create_dir_all(&shim).unwrap();
    let called = scratch.path().join("git-was-called");
    write_hook(
        &shim.join("git"),
        &format!("printf '%s\\n' \"$*\" >> {}\nexit 127\n", sh_quote(&called)),
    );
    let path_with_shim = format!(
        "{}:{}",
        shim.to_str().unwrap(),
        std::env::var("PATH").unwrap_or_default()
    );
    let message = scratch.path().join("message");
    fs::write(&message, "subject\n\nbody\n").unwrap();
    // Run the hook the way git would, so the shim only sees calls the hook makes.
    let mut cmd = std::process::Command::new("sh");
    cmd.arg(Path::new(&armed.hooks_path).join("prepare-commit-msg"));
    cmd.arg(&message);
    for (key, value) in &crew {
        cmd.env(key, value);
    }
    cmd.env("PATH", path_with_shim);
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "{out:?}");
    assert!(
        !called.exists(),
        "the hook ran git: {}",
        fs::read_to_string(&called).unwrap_or_default()
    );
    assert!(ran.is_file(), "the repository hook did not run");
    let body = fs::read_to_string(&message).unwrap();
    assert!(body.contains("Repo-Ran: yes"), "{body}");
    assert!(body.contains("Hivra-Chat: chat-1"), "{body}");
}

#[test]
fn a_home_relative_hooks_path_is_expanded() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let global = fs::read_to_string(&made.global).unwrap();
    fs::write(
        &made.global,
        format!("{global}[core]\n\thooksPath = \"~/my hooks\"\n"),
    )
    .unwrap();
    let hooks = made.home.join("my hooks");
    let ran = scratch.path().join("home-hook-ran");
    write_hook(
        &hooks.join("pre-commit"),
        &format!("printf 'home\\n' > {}\nexit 1\n", sh_quote(&ran)),
    );
    let armed = arm(&scratch.path().join("data"), &made.repo, &base);
    let crew = crew_pairs(&base, &armed);
    fs::write(made.repo.join("note.txt"), "note\n").unwrap();
    git(&made.repo, &crew, &["add", "note.txt"]).unwrap();
    assert!(git(
        &made.repo,
        &crew,
        &["commit", "-m", "blocked by home hooks"]
    )
    .is_err());
    assert!(
        ran.is_file(),
        "the ~ hooks path was not expanded and forwarded"
    );
}

/// receive.denyCurrentBranch=updateInstead updates the files itself, but only
/// when no push-to-checkout hook exists. The crew's environment must not get
/// in the way: the ref and the working tree both move.
#[test]
fn a_crew_push_updates_a_checked_out_worktree() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    let remote = scratch.path().join("remote");
    fs::create_dir_all(&remote).unwrap();
    git(&remote, &base, &["init", "-b", "main"]).unwrap();
    fs::write(remote.join("keep.txt"), "base\n").unwrap();
    git(&remote, &base, &["add", "keep.txt"]).unwrap();
    git(&remote, &base, &["commit", "-m", "base"]).unwrap();
    git(
        &remote,
        &base,
        &["config", "receive.denyCurrentBranch", "updateInstead"],
    )
    .unwrap();
    let config_before = fs::read(remote.join(".git").join("config")).unwrap();
    let local = scratch.path().join("local");
    git(
        scratch.path(),
        &base,
        &["clone", remote.to_str().unwrap(), local.to_str().unwrap()],
    )
    .unwrap();
    fs::write(local.join("keep.txt"), "pushed\n").unwrap();
    git(&local, &base, &["add", "keep.txt"]).unwrap();
    git(&local, &base, &["commit", "-m", "push"]).unwrap();
    let armed = arm(&scratch.path().join("data"), &local, &base);
    assert!(
        !Path::new(&armed.hooks_path)
            .join("push-to-checkout")
            .exists(),
        "push-to-checkout is installed, so receive-pack will not update the worktree"
    );
    let crew = crew_pairs(&base, &armed);
    git(
        &local,
        &crew,
        &["push", remote.to_str().unwrap(), "HEAD:main"],
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(remote.join("keep.txt")).unwrap(),
        "pushed\n",
        "the ref moved and the working tree did not"
    );
    let status = git(&remote, &base, &["status", "--porcelain"]).unwrap();
    assert_eq!(status.trim(), "", "worktree left dirty: {status}");
    assert_eq!(
        git(&remote, &base, &["rev-parse", "HEAD"]).unwrap(),
        git(&local, &base, &["rev-parse", "HEAD"]).unwrap()
    );
    assert_eq!(
        fs::read(remote.join(".git").join("config")).unwrap(),
        config_before,
        "the push wrote the remote config"
    );
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
    let armed = arm(&scratch.path().join("data"), &made.repo, &base);
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

    let armed = arm(&scratch.path().join("data dir"), &made.repo, &base);
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
    let armed = arm(&scratch.path().join("data"), &made.repo, &base);
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
    let armed = arm(&scratch.path().join("data"), &repo, &base);
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
    // The guard here is a stand-in that passes, so this proves the forwarding; the guard itself is tested in commit_guard.
    let stand_in = scratch.path().join("guard-stand-in");
    write_hook(&stand_in, "exit 0\n");
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let hooks =
        super::hooks::install_for_repo_with(&data, &made.repo, &env_pairs(&base), &stand_in)
            .unwrap();
    let hooks_path = hooks.to_str().unwrap().to_string();
    let (count, key, value_name) = super::logic::git_config_env(None, &hooks_path).unwrap();
    let armed = Armed {
        count,
        key,
        value_name,
        hooks_path,
    };
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
    let armed = arm(&scratch.path().join("data"), &wt, &base);
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
    let armed = arm(&scratch.path().join("data"), &made.repo, &base);
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
    let armed = arm(&scratch.path().join("data"), &made.repo, &base);
    let crew = crew_pairs(&base, &armed);
    fs::write(made.repo.join("next.txt"), "next\n").unwrap();
    git(&made.repo, &crew, &["add", "next.txt"]).unwrap();
    git(&made.repo, &crew, &["commit", "-m", "past a disabled hook"]).unwrap();
    assert!(!ran.exists(), "a non-executable hook ran");
    let body = git(&made.repo, &base, &["log", "-1", "--format=%B"]).unwrap();
    assert!(body.contains("Hivra-Chat: chat-1"), "{body}");
}

#[test]
fn the_journal_skips_binary_and_oversized_files() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let kept = "distinctive kept widget line alpha";
    fs::write(made.repo.join("keep.txt"), format!("{kept}\n")).unwrap();
    let hidden = "distinctive binary widget must not count";
    let mut binary = vec![0u8];
    binary.extend(hidden.as_bytes());
    binary.push(b'\n');
    fs::write(made.repo.join("blob.bin"), binary).unwrap();
    let too_big = "distinctive oversized widget must not count";
    let mut huge = format!("{too_big}\n").into_bytes();
    huge.resize(super::git::MAX_FILE_BYTES as usize + 1, b'x');
    fs::write(made.repo.join("huge.txt"), huge).unwrap();
    let exact = "distinctive exact size widget is kept";
    let mut fitted = format!("{exact}\n").into_bytes();
    fitted.resize(super::git::MAX_FILE_BYTES as usize, b'y');
    fs::write(made.repo.join("fitted.txt"), fitted).unwrap();
    let dirty = super::git::dirty_hashes(&made.repo).unwrap();
    assert!(dirty.hashes.contains(&super::logic::hash_line(kept)));
    assert!(dirty.hashes.contains(&super::logic::hash_line(exact)));
    assert!(!dirty.hashes.contains(&super::logic::hash_line(hidden)));
    assert!(!dirty.hashes.contains(&super::logic::hash_line(too_big)));
}

#[test]
fn the_journal_caps_the_total_number_of_lines() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let cap = super::git::MAX_LINES;
    let mut text = String::new();
    for n in 1..=cap + 20 {
        text.push_str(&format!("distinctive widget line {n:05} stays\n"));
    }
    fs::write(made.repo.join("a-lines.txt"), text).unwrap();
    let sentinel = "distinctive sentinel past the line cap";
    fs::write(made.repo.join("z-sentinel.txt"), format!("{sentinel}\n")).unwrap();
    let dirty = super::git::dirty_hashes(&made.repo)
        .expect("a tree past the line cap is capped, not a failed read");
    assert!(dirty.truncated, "lines past the cap were dropped");
    assert!(dirty.hashes.len() <= cap, "{}", dirty.hashes.len());
    assert!(dirty.hashes.contains(&super::logic::hash_line(
        "distinctive widget line 00001 stays"
    )));
    assert!(!dirty.hashes.contains(&super::logic::hash_line(&format!(
        "distinctive widget line {:05} stays",
        cap + 20
    ))));
    assert!(!dirty.hashes.contains(&super::logic::hash_line(sentinel)));
    let via_retry = super::lines_before_run(&made.repo).expect("a full cap is not a failed read");
    assert!(via_retry.truncated);
    assert_eq!(via_retry.hashes, dirty.hashes);
}

fn fill_lines(count: usize) -> String {
    let mut text = String::new();
    for n in 1..=count {
        text.push_str(&format!("distinctive widget line {n:05} stays\n"));
    }
    text
}

#[test]
fn the_line_cap_is_only_truncated_when_a_line_was_left_out() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let cap = super::git::MAX_LINES;
    let path = made.repo.join("a-lines.txt");
    fs::write(&path, fill_lines(cap)).unwrap();
    let exact = super::git::dirty_hashes(&made.repo).unwrap();
    assert_eq!(exact.hashes.len(), cap);
    assert!(!exact.truncated, "a read that finished on the cap is whole");

    let mut boilerplate = fill_lines(cap);
    boilerplate.push_str("short\n");
    fs::write(&path, boilerplate).unwrap();
    let tail = super::git::dirty_hashes(&made.repo).unwrap();
    assert!(!tail.truncated, "a boilerplate tail is not a dropped line");
    assert_eq!(tail.hashes.len(), cap);

    let mut duplicate = fill_lines(cap);
    duplicate.push_str("distinctive widget line 00001 stays\n");
    fs::write(&path, duplicate).unwrap();
    let again = super::git::dirty_hashes(&made.repo).unwrap();
    assert!(
        !again.truncated,
        "a repeated line is already in the snapshot"
    );

    let mut overflow = fill_lines(cap);
    let extra = "distinctive widget line past the stored cap";
    overflow.push_str(extra);
    overflow.push('\n');
    fs::write(&path, overflow).unwrap();
    let cut = super::git::dirty_hashes(&made.repo).unwrap();
    assert!(cut.truncated);
    assert!(!cut.hashes.contains(&super::logic::hash_line(extra)));
    assert!(cut.hashes.contains(&super::logic::hash_line(
        "distinctive widget line 00001 stays"
    )));
}

#[test]
fn a_tracked_diff_past_the_cap_is_truncated() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(
        made.repo.join("tracked.txt"),
        "base line that stays tracked\n",
    )
    .unwrap();
    git(&made.repo, &base, &["add", "tracked.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let cap = super::git::MAX_LINES;
    fs::write(made.repo.join("tracked.txt"), fill_lines(cap + 1)).unwrap();
    let dirty = super::git::dirty_hashes(&made.repo).unwrap();
    assert!(dirty.truncated);
    assert!(dirty.hashes.contains(&super::logic::hash_line(
        "distinctive widget line 00001 stays"
    )));
    assert!(!dirty.hashes.contains(&super::logic::hash_line(&format!(
        "distinctive widget line {:05} stays",
        cap + 1
    ))));
}

#[test]
fn a_truncated_before_read_is_not_journaled() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let cap = super::git::MAX_LINES;
    fs::write(made.repo.join("a-lines.txt"), fill_lines(cap + 20)).unwrap();
    let sentinel = "distinctive sentinel past the line cap";
    fs::write(made.repo.join("z-sentinel.txt"), format!("{sentinel}\n")).unwrap();
    let before = super::start_before_run(&made.repo)
        .wait()
        .expect("the before read finished");
    let past = super::logic::hash_line(&format!("distinctive widget line {:05} stays", cap + 1));
    let sentinel_hash = super::logic::hash_line(sentinel);
    assert!(before.truncated);
    assert!(!before.hashes.contains(&past));
    assert!(!before.hashes.contains(&sentinel_hash));

    let mut kept = String::new();
    for n in 31..=cap + 20 {
        kept.push_str(&format!("distinctive widget line {n:05} stays\n"));
    }
    fs::write(made.repo.join("a-lines.txt"), kept).unwrap();
    let crew = "distinctive crew widget written during the run";
    fs::write(made.repo.join("m-during.txt"), format!("{crew}\n")).unwrap();
    let after = super::git::dirty_hashes(&made.repo).unwrap();
    let crew_hash = super::logic::hash_line(crew);
    for hash in [&past, &sentinel_hash, &crew_hash] {
        assert!(
            after.hashes.contains(hash) && !before.hashes.contains(hash),
            "a pre-existing line did not land in the after window"
        );
    }
    let decision = super::journal_additions(&before, || {
        panic!("a truncated before read must not be differenced")
    });
    assert!(
        decision.unwrap().is_none(),
        "a truncated before read was journaled"
    );
}

#[test]
fn a_finished_before_read_journals_only_the_new_line() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    let old = "distinctive line that was already dirty";
    fs::write(made.repo.join("old.txt"), format!("{old}\n")).unwrap();
    let before = super::start_before_run(&made.repo)
        .wait()
        .expect("the before read finished");
    assert!(!before.truncated);
    let crew = "distinctive crew widget written during the run";
    fs::write(made.repo.join("new.txt"), format!("{crew}\n")).unwrap();
    let (_repo, fresh) = super::journal_additions(&before, || super::git::dirty_hashes(&made.repo))
        .unwrap()
        .expect("a finished before read is journaled");
    assert_eq!(fresh, vec![super::logic::hash_line(crew)]);
    assert!(!fresh.contains(&super::logic::hash_line(old)));
}

struct PauseReset;

impl Drop for PauseReset {
    fn drop(&mut self) {
        super::set_journal_pause_for_test(0);
    }
}

#[test]
fn harness_spawn_does_not_wait_on_a_slow_journal() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    git(&made.repo, &made.env(), &["init", "-b", "main"]).unwrap();
    super::set_journal_pause_for_test(800);
    let _reset = PauseReset;
    let started = std::time::Instant::now();
    let pending = super::start_before_run(&made.repo);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_millis(300),
        "the turn waited {elapsed:?} on the journal"
    );
    let waited = std::time::Instant::now();
    let got = pending.wait();
    assert!(
        waited.elapsed() >= std::time::Duration::from_millis(500),
        "the journal did not run in the background"
    );
    assert!(got.is_some(), "the journal did not finish");
}

/// WP-248: a crew's shell commit runs the commit guard (`pre-commit-guard`) before git makes the commit. A refusal
/// stops the commit and the repository's own pre-commit hook does not run; a pass runs that hook next.
#[test]
fn pre_commit_runs_the_guard_first_and_its_refusal_stops_the_commit() {
    let scratch = Scratch::new();
    let made = GitRepo::new(&scratch);
    let base = made.env();
    git(&made.repo, &base, &["init", "-b", "main"]).unwrap();
    fs::write(made.repo.join("keep.txt"), "base\n").unwrap();
    git(&made.repo, &base, &["add", "keep.txt"]).unwrap();
    git(&made.repo, &base, &["commit", "-m", "base"]).unwrap();
    let real_ran = scratch.path().join("real-pre-commit-ran");
    write_hook(
        &made.repo.join(".git").join("hooks").join("pre-commit"),
        &format!("printf 'ran\\n' >> {}\nexit 0\n", sh_quote(&real_ran)),
    );
    let guard_args = scratch.path().join("guard-args");
    let verdict = scratch.path().join("guard-verdict");
    // The stand-in guard records how it was called and answers with the exit code in `verdict`.
    let stand_in = scratch.path().join("guard-stand-in");
    write_hook(
        &stand_in,
        &format!(
            "printf '%s\\n' \"$@\" > {}\nexit \"$(cat {})\"\n",
            sh_quote(&guard_args),
            sh_quote(&verdict)
        ),
    );
    let data = scratch.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let hooks =
        super::hooks::install_for_repo_with(&data, &made.repo, &env_pairs(&base), &stand_in)
            .unwrap();
    let hooks_path = hooks.to_str().unwrap().to_string();
    let (count, key, value_name) = super::logic::git_config_env(None, &hooks_path).unwrap();
    let armed = Armed {
        count,
        key,
        value_name,
        hooks_path,
    };
    let crew = crew_pairs(&base, &armed);

    fs::write(&verdict, "1").unwrap();
    fs::write(made.repo.join("keep.txt"), "refused\n").unwrap();
    assert!(git(&made.repo, &crew, &["commit", "-am", "refused"]).is_err());
    let args = fs::read_to_string(&guard_args).unwrap_or_default();
    let mut lines = args.lines();
    assert_eq!(lines.next(), Some("pre-commit-guard"), "{args}");
    assert_eq!(lines.next(), Some("--store"), "{args}");
    assert!(
        lines
            .next()
            .is_some_and(|store| store.ends_with("commit-guard-allows.json")),
        "{args}"
    );
    assert!(
        !real_ran.exists(),
        "the repository's hook ran after a refusal"
    );
    let log = git(&made.repo, &base, &["log", "--format=%s"]).unwrap();
    assert!(!log.contains("refused"), "the commit was made: {log}");

    fs::write(&verdict, "0").unwrap();
    git(&made.repo, &crew, &["commit", "-am", "passed"]).unwrap();
    assert!(
        real_ran.exists(),
        "the repository's own pre-commit hook did not run"
    );
    let log = git(&made.repo, &base, &["log", "--format=%s"]).unwrap();
    assert!(log.contains("passed"), "{log}");
}
