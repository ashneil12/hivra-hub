//! WP-248: a crew's local commit is checked before it is made (the pre-commit guard), and an approvals file is refused
//! even when the repository already tracks it, unless a person allowed that repository to keep it.

use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const APPROVALS_PATH: &str = ".claude/settings.local.json";

struct Repo(PathBuf);

impl Repo {
    fn dir(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "commit-guard-wp248-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn new(tag: &str) -> Self {
        let repo = Self::dir(tag);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "guard@example.test"]);
        repo.git(&["config", "user.name", "Guard Test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn git_env(&self, env: &[(&str, &Path)], args: &[&str]) -> String {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.0).args(args);
        for (key, value) in env {
            cmd.env(key, value);
        }
        let out = cmd.output().expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_env(&[], args)
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn commit_all(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "--no-verify", "-m", message]);
    }

    /// A repository whose first commit already tracks the approvals file (a past leak).
    fn tracking_approvals(tag: &str) -> Self {
        let repo = Self::new(tag);
        repo.write("README.md", "hello\n");
        repo.write(APPROVALS_PATH, "{\"permissions\":{\"allow\":[]}}\n");
        repo.git(&["add", "-f", APPROVALS_PATH, "README.md"]);
        repo.git(&["commit", "-q", "--no-verify", "-m", "base"]);
        repo
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The refusal id a refusal carries, in the shape the webview reads (`refusal.ts`).
fn refusal_id_in(text: &str) -> String {
    let at = text.find("(refusal ").expect("the refusal carries an id") + "(refusal ".len();
    let id: String = text[at..].chars().take(12).collect();
    assert!(
        text[at + 12..].starts_with("). "),
        "the id must end the way refusal.ts reads it: {text}"
    );
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "{text}");
    id
}

#[test]
fn the_pre_commit_check_refuses_a_new_approvals_file() {
    let repo = Repo::new("new-approvals");
    repo.write("README.md", "hello\n");
    repo.commit_all("base");
    repo.write(
        APPROVALS_PATH,
        "{\"permissions\":{\"allow\":[\"Bash(make)\"]}}\n",
    );
    repo.git(&["add", "-f", APPROVALS_PATH]);
    let err = pre_commit_check(repo.path()).unwrap_err();
    assert!(
        err.starts_with(
            "Refused to commit .claude/settings.local.json: it is an agent's local approvals, not for GitHub."
        ),
        "{err}"
    );
}

#[test]
fn the_pre_commit_check_refuses_a_saved_transcript_and_passes_a_plain_change() {
    let repo = Repo::new("transcript");
    repo.write("README.md", "hello\n");
    repo.commit_all("base");
    repo.write("src/app.txt", "shipped\n");
    repo.git(&["add", "src/app.txt"]);
    pre_commit_check(repo.path()).expect("an ordinary change commits");
    repo.write(".claude/projects/app/session.jsonl", "{\"turn\":1}\n");
    repo.git(&["add", "-f", ".claude/projects/app/session.jsonl"]);
    let err = pre_commit_check(repo.path()).unwrap_err();
    assert!(
        err.starts_with("Refused to commit .claude/projects/app/session.jsonl: it is an agent's saved transcript"),
        "{err}"
    );
}

#[test]
fn the_pre_commit_check_works_before_the_first_commit() {
    let repo = Repo::new("unborn");
    repo.write("README.md", "hello\n");
    repo.git(&["add", "README.md"]);
    pre_commit_check(repo.path()).expect("a clean first commit passes");
    repo.write(APPROVALS_PATH, "{}\n");
    repo.git(&["add", "-f", APPROVALS_PATH]);
    let err = pre_commit_check(repo.path()).unwrap_err();
    assert!(
        err.starts_with("Refused to commit .claude/settings.local.json"),
        "{err}"
    );
}

#[test]
fn the_pre_commit_check_finds_a_command_line_password_without_showing_it() {
    let repo = Repo::new("password");
    repo.write("README.md", "hello\n");
    repo.commit_all("base");
    // A made-up password, in the shape Claude Code saves an approved command.
    repo.write(
        "scripts/db.sh",
        "#!/bin/sh\nPGPASSWORD=hunter2x psql -h db.example.com -U app\n",
    );
    repo.git(&["add", "scripts/db.sh"]);
    let err = pre_commit_check(repo.path()).unwrap_err();
    assert!(
        err.starts_with("Possible secret in scripts/db.sh:2"),
        "{err}"
    );
    assert!(
        !err.contains("hunter2x"),
        "the value must not be shown: {err}"
    );
}

#[test]
fn the_pre_commit_check_reads_the_index_git_is_committing() {
    // `git commit -a` and `git commit <paths>` commit a temporary index that git names in GIT_INDEX_FILE.
    let repo = Repo::new("temp-index");
    repo.write("README.md", "hello\n");
    repo.commit_all("base");
    let real = repo.path().join(".git").join("index");
    let temp = repo.path().join(".git").join("next-index-test.lock");
    fs::copy(&real, &temp).unwrap();
    repo.write(APPROVALS_PATH, "{}\n");
    repo.git_env(&[("GIT_INDEX_FILE", &temp)], &["add", "-f", APPROVALS_PATH]);
    pre_commit_check(repo.path()).expect("the default index is clean");
    let opened = objects::open_repo(repo.path()).unwrap();
    let err = pre_commit_in(repo.path(), &opened, &temp).unwrap_err();
    assert!(
        err.starts_with("Refused to commit .claude/settings.local.json"),
        "{err}"
    );
}

#[test]
fn a_tracked_approvals_file_that_changes_is_refused_with_an_id() {
    let repo = Repo::tracking_approvals("tracked-commit");
    repo.write(
        APPROVALS_PATH,
        "{\"permissions\":{\"allow\":[\"Bash(make test)\"]}}\n",
    );
    // The app's commit of chosen files.
    let err = refuse_selected(repo.path(), &[APPROVALS_PATH.to_string()]).unwrap_err();
    assert!(
        err.starts_with(
            "Refused to commit .claude/settings.local.json: it is an agent's local approvals, and this repository tracks it."
        ),
        "{err}"
    );
    refusal_id_in(&err);
    // The app's commit of whatever is staged, and the crew's pre-commit hook.
    repo.git(&["add", APPROVALS_PATH]);
    let err = refuse_staged_agent_files(repo.path()).unwrap_err();
    assert!(err.contains("this repository tracks it"), "{err}");
    let err = pre_commit_check(repo.path()).unwrap_err();
    assert!(err.contains("this repository tracks it"), "{err}");
    assert!(
        err.contains("git rm --cached .claude/settings.local.json"),
        "{err}"
    );
}

#[test]
fn untracking_an_approvals_file_is_never_refused() {
    let repo = Repo::tracking_approvals("untrack");
    repo.git(&["rm", "-q", "--cached", APPROVALS_PATH]);
    refuse_staged_agent_files(repo.path()).expect("removing it from the index is the fix");
    pre_commit_check(repo.path()).expect("removing it from the index is the fix");
    fs::remove_file(repo.path().join(APPROVALS_PATH)).unwrap();
    refuse_selected(repo.path(), &[APPROVALS_PATH.to_string()])
        .expect("selecting its removal is the fix");
}

#[test]
fn a_tracked_transcript_keeps_its_exemption() {
    let repo = Repo::new("tracked-transcript");
    repo.write("README.md", "hello\n");
    repo.write(".claude/fixtures/turns.jsonl", "{\"turn\":1}\n");
    repo.git(&["add", "-f", "README.md", ".claude/fixtures/turns.jsonl"]);
    repo.git(&["commit", "-q", "--no-verify", "-m", "base"]);
    repo.write(
        ".claude/fixtures/turns.jsonl",
        "{\"turn\":1}\n{\"turn\":2}\n",
    );
    repo.git(&["add", ".claude/fixtures/turns.jsonl"]);
    refuse_staged_agent_files(repo.path()).expect("only the approvals file loses the exemption");
    pre_commit_check(repo.path()).expect("only the approvals file loses the exemption");
}

#[test]
fn a_push_that_changes_a_tracked_approvals_file_is_refused() {
    let remote = Repo::dir("tracked-push-remote");
    Command::new("git")
        .arg("-C")
        .arg(remote.path())
        .args(["init", "-q", "--bare", "-b", "main"])
        .status()
        .unwrap();
    let local = Repo::tracking_approvals("tracked-push");
    local.git(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
    local.git(&["push", "-q", "--no-verify", "-u", "origin", "main"]);
    local.write(
        APPROVALS_PATH,
        "{\"permissions\":{\"allow\":[\"Bash(make test)\"]}}\n",
    );
    local.git(&["commit", "-q", "--no-verify", "-am", "approve make"]);
    let err = gate_outgoing(local.path()).unwrap_err();
    assert!(
        err.starts_with(
            "Refused to push .claude/settings.local.json: it is an agent's local approvals, and this repository tracks it."
        ),
        "{err}"
    );
}

#[test]
fn a_person_can_allow_one_repository_to_keep_its_approvals_file() {
    let repo = Repo::tracking_approvals("allow");
    let other = Repo::tracking_approvals("allow-other");
    let changed = [APPROVALS_PATH];
    let err =
        refuse_tracked_approvals_with(repo.path(), "Refused to commit", changed, &[]).unwrap_err();
    let id = refusal_id_in(&err);
    let store = repo.path().join("allows").join("commit-guard-allows.json");
    let key = b"wp248-test-key";
    allow_refusal_with(&store, &id, key).expect("the person's allow is recorded");
    let allows = read_allows_with(&store, key);
    assert_eq!(allows.len(), 1);
    assert_eq!(allows[0].hash, TRACKED_APPROVALS);
    refuse_tracked_approvals_with(repo.path(), "Refused to commit", changed, &allows)
        .expect("this repository is allowed to keep it");
    // Only that repository, and only that file.
    assert!(
        refuse_tracked_approvals_with(other.path(), "Refused to commit", changed, &allows).is_err()
    );
    assert!(refuse_tracked_approvals_with(
        repo.path(),
        "Refused to commit",
        [".codex/settings.local.json"],
        &allows
    )
    .is_err());
    // A hand-written entry is not an allow: it carries no valid signature.
    let forged = Allow {
        repo: repo_id(other.path()),
        file: APPROVALS_PATH.to_string(),
        hash: TRACKED_APPROVALS.to_string(),
        mac: "00".repeat(32),
    };
    let mut entries = read_raw(&store);
    entries.push(forged);
    write_allows(&store, &entries).unwrap();
    let allows = read_allows_with(&store, key);
    assert!(
        refuse_tracked_approvals_with(other.path(), "Refused to commit", changed, &allows).is_err()
    );
}
