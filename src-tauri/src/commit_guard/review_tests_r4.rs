//! Review of PR #227 (WP-200), round 4: the repros, now asserting the structural fix (round 5). Each test states what the
//! guard must do.

use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn fake_key() -> String {
    format!("sk-ant-{}", "Ab3dEf7h".repeat(4))
}

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn temp(tag: &str) -> Dir {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("cg-r4-{tag}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    Dir(std::fs::canonicalize(&path).unwrap())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(dir: &Path, rel: &str, bytes: &[u8]) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

/// A repo whose `origin` already holds one commit.
fn pushed(tag: &str) -> (Dir, Dir) {
    let remote = temp(&format!("{tag}-remote"));
    git(&remote.0, &["init", "-q", "--bare", "-b", "main"]);
    let local = temp(tag);
    git(&local.0, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.email", "guard@example.test"),
        ("user.name", "Guard Test"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(&local.0, &["config", key, value]);
    }
    git(
        &local.0,
        &["remote", "add", "origin", remote.0.to_str().unwrap()],
    );
    write(&local.0, "README.md", b"hello\n");
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "base"]);
    git(&local.0, &["push", "-q", "-u", "origin", "main"]);
    (local, remote)
}

fn secret_line() -> String {
    format!("const KEY: &str = \"{}\";\n", fake_key())
}

fn commit_all(local: &Path, message: &str) -> String {
    git(local, &["add", "-A"]);
    git(local, &["commit", "-q", "-m", message]);
    git(local, &["rev-parse", "HEAD"]).trim().to_string()
}

/// What git writes on a pre-push hook's stdin for `git push origin <sha>:refs/heads/<name>` to a new branch.
fn ref_line(sha: &str, name: &str) -> String {
    format!(
        "refs/heads/{name} {sha} refs/heads/{name} {}\n",
        "0".repeat(40)
    )
}

// HIGH: `log.showRoot=false` (repo or person config, not overridden by guard_git) drops a root commit's diff and names
// from `git log`. A new orphan branch, or the first push of a new repository, then sends every file unscanned.
#[test]
fn m1_log_show_root_false_does_not_hide_a_root_commit() {
    let (local, _remote) = pushed("showroot");
    git(&local.0, &["checkout", "-q", "--orphan", "leak"]);
    git(&local.0, &["rm", "-rqf", "."]);
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    let sha = commit_all(&local.0, "root");
    git(&local.0, &["config", "log.showRoot", "false"]);
    assert!(
        pre_push_stdin_check(&local.0, "origin", &ref_line(&sha, "leak")).is_err(),
        "log.showRoot=false hid a secret in a root commit from the pre-push check"
    );
}

// HIGH: `--diff-merges=remerge` skips octopus merges ("Skipping remerge-diff for octopus merges"), so a secret or an
// agent file added in a merge of three or more parents is never seen (the round-1 H2 class).
#[test]
fn m2_an_octopus_merge_does_not_hide_a_secret_or_an_agent_file() {
    let (local, _remote) = pushed("octopus");
    for branch in ["o1", "o2"] {
        git(&local.0, &["checkout", "-q", "-b", branch, "main"]);
        write(&local.0, &format!("{branch}.txt"), b"x\n");
        commit_all(&local.0, branch);
    }
    git(&local.0, &["checkout", "-q", "main"]);
    write(&local.0, "m.txt", b"m\n");
    commit_all(&local.0, "m");
    git(&local.0, &["merge", "-q", "--no-commit", "o1", "o2"]);
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    write(
        &local.0,
        ".claude/settings.local.json",
        b"{\"permissions\":{}}\n",
    );
    git(&local.0, &["add", "-f", ".claude/settings.local.json"]);
    commit_all(&local.0, "octopus");
    let parents = git(&local.0, &["log", "-1", "--format=%P"]);
    assert_eq!(parents.split_whitespace().count(), 3, "fixture: octopus");
    assert!(
        gate_outgoing(&local.0).is_err(),
        "an octopus merge carried a secret and .claude/settings.local.json past the gate"
    );
}

// MEDIUM: a replace ref makes `git log` show another commit's content, while `git push` sends the real objects.
#[test]
fn m3_a_replace_ref_does_not_hide_a_secret() {
    let (local, remote) = pushed("replace");
    let base = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    git(&local.0, &["checkout", "-q", "-b", "leak"]);
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    let secret = commit_all(&local.0, "config");
    git(&local.0, &["checkout", "-q", "-b", "clean", &base]);
    write(&local.0, "src/config.rs", b"// nothing here\n");
    let clean = commit_all(&local.0, "config");
    git(&local.0, &["replace", &secret, &clean]);
    // The real push sends the real commit (the remote then has the secret).
    git(&local.0, &["push", "-q", "origin", "leak:refs/heads/probe"]);
    let sent = Command::new("git")
        .arg("-C")
        .arg(&remote.0)
        .args(["show", "probe:src/config.rs"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&sent.stdout).contains("sk-ant-"),
        "fixture: the push sends the replaced commit's real content"
    );
    git(&remote.0, &["update-ref", "-d", "refs/heads/probe"]);
    git(&remote.0, &["gc", "-q", "--prune=now"]);
    assert!(
        pre_push_stdin_check(&local.0, "origin", &ref_line(&secret, "leak")).is_err(),
        "a replace ref hid a secret from the pre-push check"
    );
}

// MEDIUM: the base comes from `git ls-remote <remote>`, which reads the fetch URL; `git push` uses the push URL. With
// `remote.origin.url=.` (this checkout) and `pushurl` set to the real remote, every local commit is "advertised".
#[test]
fn m4_a_fetch_url_unlike_the_push_url_does_not_hide_a_secret() {
    let (local, remote) = pushed("pushurl");
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    commit_all(&local.0, "config");
    git(
        &local.0,
        &[
            "config",
            "remote.origin.pushurl",
            remote.0.to_str().unwrap(),
        ],
    );
    git(&local.0, &["config", "remote.origin.url", "."]);
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a fetch URL pointing at the checkout itself hid a secret from the push gate"
    );
}

// MEDIUM: `diff.relative=true` limits `git log -p` to the folder git runs in. The app gates `-C <project folder>`, which
// may be a subfolder of the repository (a monorepo project), so a secret elsewhere in the repo is not seen.
#[test]
fn m5_diff_relative_does_not_hide_a_secret_outside_the_project_folder() {
    let (local, _remote) = pushed("relative");
    write(&local.0, "app/main.rs", b"fn main() {}\n");
    write(&local.0, "config.rs", secret_line().as_bytes());
    commit_all(&local.0, "work");
    git(&local.0, &["config", "diff.relative", "true"]);
    assert!(
        gate_outgoing(&local.0.join("app")).is_err(),
        "diff.relative=true hid a secret outside the project subfolder"
    );
}
