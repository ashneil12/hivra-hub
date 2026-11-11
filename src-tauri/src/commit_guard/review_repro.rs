//! Review of PR #227 (WP-200), round 1: red-first repros. Each test states the behaviour the guard should have; on the
//! PR head every one of them fails.

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
    let path = std::env::temp_dir().join(format!("cg-review-{tag}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    Dir(crate::fs::canonical(path).unwrap())
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

fn init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "guard@example.test"]);
    git(dir, &["config", "user.name", "Guard Test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

/// A repo whose `origin` already holds one commit.
fn pushed(tag: &str) -> (Dir, Dir) {
    let remote = temp(&format!("{tag}-remote"));
    git(&remote.0, &["init", "-q", "--bare", "-b", "main"]);
    let local = temp(tag);
    init(&local.0);
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

/// A merge commit made the usual way after a conflict-free `git merge --no-commit`, with extra files staged into it.
fn merge_with(local: &Path, files: &[(&str, &[u8])]) {
    git(local, &["checkout", "-q", "-b", "side"]);
    write(local, "side.txt", b"side\n");
    git(local, &["add", "-A"]);
    git(local, &["commit", "-q", "-m", "side"]);
    git(local, &["checkout", "-q", "main"]);
    write(local, "main.txt", b"main\n");
    git(local, &["add", "-A"]);
    git(local, &["commit", "-q", "-m", "main"]);
    git(local, &["merge", "-q", "--no-ff", "--no-commit", "side"]);
    for (rel, bytes) in files {
        write(local, rel, bytes);
        git(local, &["add", "-f", rel]);
    }
    git(local, &["commit", "-q", "-m", "merge side"]);
}

// HIGH: an agent file added while resolving a merge is never seen (`--no-merges` drops the merge commit).
#[test]
fn r1_an_agent_file_added_in_a_merge_commit_stops_the_push() {
    let (local, _remote) = pushed("merge-agent");
    merge_with(
        &local.0,
        &[(".claude/settings.local.json", b"{\"permissions\":{}}\n")],
    );
    let tree = git(&local.0, &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert!(tree.contains(".claude/settings.local.json"), "fixture");
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a merge commit carried .claude/settings.local.json past the outgoing gate"
    );
}

// HIGH: a secret added while resolving a merge is never scanned.
#[test]
fn r2_a_secret_added_in_a_merge_commit_stops_the_push() {
    let (local, _remote) = pushed("merge-secret");
    let line = format!("const KEY: &str = \"{}\";\n", fake_key());
    merge_with(&local.0, &[("src/config.rs", line.as_bytes())]);
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a merge commit carried a secret past the outgoing gate"
    );
}

// MEDIUM: an attribute that marks a file binary (`-diff`, `binary`) hides it from the scan; a local
// .git/info/attributes is enough, nothing is committed.
#[test]
fn r3_a_secret_in_a_file_marked_binary_by_attributes_stops_the_push() {
    let (local, _remote) = pushed("attr");
    write(&local.0, ".git/info/attributes", b"*.cfg -diff\n");
    let line = format!("key = {}\n", fake_key());
    write(&local.0, "deploy.cfg", line.as_bytes());
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "cfg"]);
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a -diff attribute hid a secret from the outgoing gate"
    );
}

// MEDIUM: a commit reachable from ANY remote-tracking ref (here a second local remote, e.g. the no-mistakes gate's
// remote) is skipped, though origin, where the push goes, has never seen it.
#[test]
fn r4_a_secret_another_remote_has_still_stops_a_push_to_origin() {
    let (local, _remote) = pushed("other-remote");
    let scratch = temp("other-remote-scratch");
    git(&scratch.0, &["init", "-q", "--bare", "-b", "main"]);
    git(
        &local.0,
        &["remote", "add", "scratch", scratch.0.to_str().unwrap()],
    );
    let line = format!("const KEY: &str = \"{}\";\n", fake_key());
    write(&local.0, "src/config.rs", line.as_bytes());
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "config"]);
    git(&local.0, &["push", "-q", "scratch", "main"]);
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a commit on another remote skipped the scan before the push to origin"
    );
}

// HIGH: ordinary code trips the generic `assignment` rule of `has_secret` (key name, then any 8 characters), and the
// refusal has no way through ("say it is a test value" is offered but nothing reads it).
#[test]
fn r5_ordinary_code_is_not_called_a_secret() {
    for line in [
        "    let token = generate_token(&conn)?;",
        "const apiKey = process.env.API_KEY;",
        "    password: Option<String>,",
        "secret = os.environ[\"APP_SECRET\"]",
        "  token: ${{ secrets.GITHUB_TOKEN }}",
    ] {
        let patch = format!("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+{line}\n");
        assert!(
            scan_patch(&patch).is_ok(),
            "ordinary code refused as a secret: {line}"
        );
    }
}

// MEDIUM: a change to a file that is not UTF-8 (a Latin-1 source file) makes the scan itself fail, so every push and
// PR of that branch is refused with a decoding error instead of a finding.
#[test]
fn r6_a_latin1_file_does_not_block_the_push() {
    let (local, _remote) = pushed("latin1");
    write(&local.0, "docs/caf\u{e9}.txt", b"caf\xe9 au lait\n");
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "latin1"]);
    let result = gate_outgoing(&local.0);
    assert!(
        result.is_ok(),
        "the scan failed on a non-UTF-8 file: {result:?}"
    );
}

// HIGH: Local delivery lands an approvals file the worker committed (or staged) itself: only untracked agent files are
// left out, and the land path never checks file names.
#[test]
fn r7_a_worker_committed_approvals_file_does_not_land() {
    let root = temp("land");
    let project = root.0.join("tally");
    fs::create_dir_all(&project).unwrap();
    init(&project);
    write(&project, "a.txt", b"one\n");
    git(&project, &["add", "-A"]);
    git(&project, &["commit", "-q", "-m", "start"]);
    let copy = root.0.join("tally-worktrees").join("mc-1");
    git(
        &project,
        &["worktree", "add", "-q", "--detach", copy.to_str().unwrap()],
    );
    write(&copy, "a.txt", b"two\n");
    write(
        &copy,
        ".claude/settings.local.json",
        b"{\"permissions\":{\"allow\":[\"Bash(curl -H x)\"]}}\n",
    );
    // What an agent does in its own shell: `git add -A && git commit`.
    git(&copy, &["add", "-A"]);
    git(&copy, &["commit", "-q", "-m", "agent work"]);
    let landed = crate::land::land(&copy, &project);
    let leaked = project.join(".claude/settings.local.json").exists();
    assert!(
        !leaked,
        "the worker's approvals file landed in the project: {:?}",
        landed.map(|l| l.files)
    );
}

// HIGH: with the delivery check on (WP-81), no-mistakes pushes and opens the pull request, and that branch of
// `deliver` never calls the guard. The PR's own grep test passes because deliver.rs calls the guard elsewhere.
#[test]
fn r8_the_checked_delivery_branch_goes_through_the_guard() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let deliver = fs::read_to_string(src.join("delivery/deliver.rs")).unwrap();
    let start = deliver.find("if gate_on {").expect("the gated branch");
    let fill = deliver[start..]
        .find("crate::delivery_gate::fill(")
        .expect("the gated branch fills the check")
        + start;
    let gate = fs::read_to_string(src.join("delivery_gate/mod.rs")).unwrap();
    let fill_fn = gate.find("pub fn fill(").expect("fill");
    let fill_body = &gate[fill_fn..gate[fill_fn..].find("\n}\n").unwrap() + fill_fn];
    assert!(
        deliver[start..fill].contains("commit_guard::gate_")
            || fill_body.contains("commit_guard::gate_"),
        "the no-mistakes delivery pushes and opens a pull request without the commit guard"
    );
}

// Measurement, not a gate: how many of this repo's own recent commits would the guard have refused?
#[test]
#[ignore]
fn r9_measure_refusals_on_this_repos_own_history() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let shas = git(
        repo,
        &["rev-list", "--no-merges", "-n", "300", "origin/main"],
    );
    let (mut refused, mut total) = (0, 0);
    for sha in shas.lines() {
        total += 1;
        if let Err(why) = gate_range(repo, &[&format!("{sha}^!")]) {
            refused += 1;
            println!("{sha} {}", why.split(". ").next().unwrap_or(""));
        }
    }
    println!("refused {refused} of {total}");
}
