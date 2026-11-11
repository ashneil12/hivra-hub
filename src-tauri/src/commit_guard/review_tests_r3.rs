//! Review of PR #227 (WP-200), round 3: the repros, now asserting the fixed behaviour (round 4). Each test states what the
//! guard must do. Adapted from the review branch: the path helper is std::fs::canonicalize, and the allow entry carries
//! its signature (empty here: an unsigned entry is what the N4 repro checks is refused).

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
    let path = std::env::temp_dir().join(format!("cg-r3-{tag}-{}-{nanos}", std::process::id()));
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

fn commit_secret(local: &Path, rel: &str) {
    let line = format!("const KEY: &str = \"{}\";\n", fake_key());
    write(local, rel, line.as_bytes());
    git(local, &["add", "-A"]);
    git(local, &["commit", "-q", "-m", "config"]);
}

// HIGH: the repository's own config (which the agent's checkout controls, or a person's ~/.gitconfig) can turn on
// colour for piped output. `git log -p` then prints every `+` and `@@` behind an escape code, `added_lines` finds no
// added line, and every gate (app push, PR, delivery, self-build, land) passes a secret.
#[test]
fn n1_a_colour_setting_does_not_hide_a_secret_from_the_push_gate() {
    let (local, _remote) = pushed("colour");
    git(&local.0, &["config", "color.ui", "always"]);
    commit_secret(&local.0, "src/config.rs");
    assert!(
        gate_outgoing(&local.0).is_err(),
        "color.ui=always hid a secret from the outgoing gate"
    );
}

// HIGH: the pre-push hook's check reads HEAD, not the refs git is pushing. `git push origin leak` (or `--all`,
// `--tags`, `<sha>:refs/heads/x`) from a clean branch sends a secret the check never looked at.
#[test]
fn n2_the_pre_push_check_covers_a_branch_that_is_not_head() {
    let (local, _remote) = pushed("not-head");
    git(&local.0, &["checkout", "-q", "-b", "leak"]);
    commit_secret(&local.0, "src/config.rs");
    git(&local.0, &["checkout", "-q", "main"]);
    // What the hook runs for `git push origin leak`: `pre-push-guard origin`, in the repository, stdin unread.
    assert!(
        pre_push_check(&local.0, "origin").is_err(),
        "the pre-push check passed a push of `leak`, which carries a secret, because HEAD is clean"
    );
}

// MEDIUM: a remote-tracking ref is the repository's own say-so. One `git update-ref` makes the gate believe origin
// already has the secret commit, so the app's push button (and the hook) send it.
#[test]
fn n3_a_forged_tracking_ref_does_not_hide_a_secret() {
    let (local, remote) = pushed("forged");
    commit_secret(&local.0, "src/config.rs");
    let head = git(&local.0, &["rev-parse", "HEAD"]);
    git(
        &local.0,
        &["update-ref", "refs/remotes/origin/seen", head.trim()],
    );
    let on_remote = Command::new("git")
        .arg("-C")
        .arg(&remote.0)
        .args(["cat-file", "-e", head.trim()])
        .status()
        .unwrap()
        .success();
    assert!(!on_remote, "fixture: origin really lacks the commit");
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a forged refs/remotes/origin/* ref hid a secret origin has never seen"
    );
}

// HIGH: the allow store is a plain JSON file in the data folder whose every field an agent can compute (sha256 of the
// repo's path, the file name, sha256 of the line). Nothing marks an entry as made by the app's UI, and no deny rule or
// credential-guard pattern names the file, so `Write`/`cat >` from an agent's shell is an allow.
#[test]
fn n4_an_allow_written_by_hand_is_not_honoured() {
    use sha2::{Digest, Sha256};
    let hex = |text: &str| -> String {
        Sha256::digest(text.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    let (local, _remote) = pushed("hand-allow");
    commit_secret(&local.0, "src/config.rs");
    let line = format!("const KEY: &str = \"{}\";", fake_key());
    let store_dir = temp("hand-allow-store");
    let store = store_dir.0.join("commit-guard-allows.json");
    // Exactly what an agent would write; no app code is called.
    let json = format!(
        "[{{\"repo\":\"{}\",\"file\":\"src/config.rs\",\"hash\":\"{}\"}}]",
        hex(&local.0.to_string_lossy()),
        hex(&line)
    );
    fs::write(&store, json).unwrap();
    let patch = git(
        &local.0,
        &[
            "log",
            "--format=",
            "-p",
            "-U0",
            "--text",
            "HEAD",
            "--not",
            "--remotes=origin",
        ],
    );
    assert!(
        scan_patch_with(&patch, &read_allows(&store), &repo_id(&local.0)).is_err(),
        "an allow an agent wrote by hand let the secret through"
    );
}

// MEDIUM: a private key is allowed by its BEGIN line, which is the same text for every key of that type, so allowing
// one test key in a file allows any other key put in that file later.
#[test]
fn n5_allowing_one_private_key_does_not_allow_another_in_the_same_file() {
    let block = |body: &str| {
        format!(
            "diff --git a/k.pem b/k.pem\n--- /dev/null\n+++ b/k.pem\n@@ -0,0 +1,3 @@\n+-----BEGIN RSA PRIVATE KEY-----\n+{body}\n+-----END RSA PRIVATE KEY-----\n"
        )
    };
    // A key is allowed by the whole block, not its BEGIN line (N5): the allow records the block's text.
    let test_key = "-----BEGIN RSA PRIVATE KEY-----\nTESTKEYTESTKEY\n-----END RSA PRIVATE KEY-----";
    let allow = Allow {
        repo: "r".into(),
        file: "k.pem".into(),
        hash: line_hash(test_key),
        mac: String::new(),
    };
    scan_patch_with(&block("TESTKEYTESTKEY"), std::slice::from_ref(&allow), "r")
        .expect("fixture: the allowed test key passes");
    assert!(
        scan_patch_with(&block("MIIEowIBAAKCAQEAreal"), &[allow], "r").is_err(),
        "an allow for one test key let a different private key through in the same file"
    );
}
