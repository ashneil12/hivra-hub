//! Review of PR #227 (WP-200), round 5: red-first repros at 5bcdaeeaf. Each test states what the guard must do; each
//! fails on the head it was written against.

use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn fake_key() -> String {
    format!("sk-ant-{}", "Ab3dEf7h".repeat(4))
}

fn secret_line() -> String {
    format!("const KEY: &str = \"{}\";\n", fake_key())
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
    let path = std::env::temp_dir().join(format!("cg-r5-{tag}-{}-{nanos}", std::process::id()));
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

fn git_ok(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn write(dir: &Path, rel: &str, bytes: &[u8]) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn configure(dir: &Path) {
    for (key, value) in [
        ("user.email", "guard@example.test"),
        ("user.name", "Guard Test"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        ("core.autocrlf", "false"),
        // The review machine's global config turns push negotiation on; the person's default is off.
        ("push.negotiate", "false"),
        ("advice.graftFileDeprecated", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
}

/// A repo whose `origin` already holds one commit.
fn pushed(tag: &str) -> (Dir, Dir) {
    let remote = temp(&format!("{tag}-remote"));
    git(&remote.0, &["init", "-q", "--bare", "-b", "main"]);
    let local = temp(tag);
    git(&local.0, &["init", "-q", "-b", "main"]);
    configure(&local.0);
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

fn commit_all(local: &Path, message: &str) -> String {
    git(local, &["add", "-A"]);
    git(local, &["commit", "-q", "-m", message]);
    git(local, &["rev-parse", "HEAD"]).trim().to_string()
}

/// A merge of `side` into main whose own content (written by `extra`) is not in either parent: an "evil" merge, or a
/// conflict resolution.
fn evil_merge(local: &Path, extra: impl FnOnce(&Path)) {
    git(local, &["checkout", "-q", "-b", "side"]);
    write(local, "side.txt", b"side\n");
    commit_all(local, "side");
    git(local, &["checkout", "-q", "main"]);
    write(local, "main.txt", b"main\n");
    commit_all(local, "main");
    git(local, &["merge", "-q", "--no-ff", "--no-commit", "side"]);
    extra(local);
    commit_all(local, "merge side");
    let parents = git(local, &["log", "-1", "--format=%P"]);
    assert_eq!(parents.split_whitespace().count(), 2, "fixture: a merge");
}

// HIGH: the text of a merge comes from the combined diff (`diff-tree -c`), and the combined diff ignores `--text`: a file
// with a NUL byte in it (a keystore, a UTF-16 file, any binary) is printed as "Binary files differ". A merge's own
// content is never another commit's, so a secret it adds is sent unchecked.
#[test]
fn r5_h1_a_merge_that_adds_a_binary_file_with_a_secret_is_refused() {
    let (local, _remote) = pushed("merge-binary");
    evil_merge(&local.0, |dir| {
        let mut bytes = b"KEYSTORE\0v1\n".to_vec();
        bytes.extend_from_slice(secret_line().as_bytes());
        write(dir, "keys/store.bin", &bytes);
    });
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a secret in a binary file added by a merge commit went past the push gate"
    );
}

// HIGH: the same hole without any binary content: `.git/info/attributes` (never committed, agent-writable) marks every
// file `-diff`, and the combined diff prints every file of every merge as "Binary files differ".
#[test]
fn r5_h1b_info_attributes_do_not_hide_the_text_of_a_merge() {
    let (local, _remote) = pushed("merge-attrs");
    evil_merge(&local.0, |dir| {
        write(dir, "src/config.rs", secret_line().as_bytes());
    });
    write(&local.0, ".git/info/attributes", b"* -diff\n");
    assert!(
        gate_outgoing(&local.0).is_err(),
        "`* -diff` in .git/info/attributes hid a merge commit's secret from the push gate"
    );
}

/// A bare repository holding `sha` under refs/heads/main, cloned from `remote`: the decoy a guard read can be pointed at.
fn decoy_holding(local: &Path, remote: &Path, root: &Path) -> PathBuf {
    let decoy = root.join("decoy.git");
    git(
        root,
        &[
            "clone",
            "-q",
            "--bare",
            remote.to_str().unwrap(),
            decoy.to_str().unwrap(),
        ],
    );
    git(
        local,
        &[
            "push",
            "-q",
            decoy.to_str().unwrap(),
            "HEAD:refs/heads/main",
        ],
    );
    decoy
}

/// Whether the remote ends up with the secret when git pushes HEAD the way the app does. The probe ref is removed after.
fn push_sends_secret(local: &Path, remote: &Path) -> bool {
    git(local, &["push", "-q", "origin", "HEAD:refs/heads/probe"]);
    let sent = git_ok(remote, &["show", "probe:src/config.rs"]).unwrap_or_default();
    git(remote, &["update-ref", "-d", "refs/heads/probe"]);
    git(remote, &["gc", "-q", "--prune=now"]);
    sent.contains("sk-ant-")
}

// HIGH: `git remote get-url --push` is right, but the guard then runs `git ls-remote <url>` in the repository, and the
// repository's config rewrites that URL (`url.<decoy>.insteadOf = <real>`). `git push` takes its URL from
// `pushInsteadOf`, which is not rewritten again. The base then comes from a decoy that advertises the secret commit, and
// nothing is scanned (M4's class).
#[test]
fn r5_h2_an_insteadof_rewrite_does_not_point_the_base_at_a_decoy() {
    let (local, remote) = pushed("insteadof");
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    commit_all(&local.0, "config");
    let scratch = temp("insteadof-scratch");
    let decoy = decoy_holding(&local.0, &remote.0, &scratch.0);
    let real = remote.0.to_str().unwrap();
    git(&local.0, &["config", "remote.origin.url", "hivra-alias:"]);
    git(
        &local.0,
        &[
            "config",
            &format!("url.{real}.pushInsteadOf"),
            "hivra-alias:",
        ],
    );
    git(
        &local.0,
        &[
            "config",
            &format!("url.{}.insteadOf", decoy.to_str().unwrap()),
            real,
        ],
    );
    assert!(
        push_sends_secret(&local.0, &remote.0),
        "fixture: git push sends the secret to the real remote"
    );
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a repository insteadOf rewrite pointed the push gate's base at a decoy and hid a secret"
    );
}

// HIGH: the same for an ssh remote: `core.sshCommand` in the repository's config serves `git-upload-pack` (what
// ls-remote runs) from a decoy and `git-receive-pack` (what push runs) from the real remote.
#[cfg(unix)]
#[test]
fn r5_h2b_core_ssh_command_does_not_point_the_base_at_a_decoy() {
    let (local, remote) = pushed("sshcommand");
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    commit_all(&local.0, "config");
    let scratch = temp("sshcommand-scratch");
    let decoy = decoy_holding(&local.0, &remote.0, &scratch.0);
    let script = scratch.0.join("ssh.sh");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nfor last; do :; done\ncase \"$last\" in\n  git-upload-pack*) exec git-upload-pack '{}' ;;\n  *) exec sh -c \"$last\" ;;\nesac\n",
            decoy.display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &local.0,
        &[
            "config",
            "remote.origin.url",
            &format!("fakehost:{}", remote.0.display()),
        ],
    );
    git(
        &local.0,
        &["config", "core.sshCommand", script.to_str().unwrap()],
    );
    assert!(
        push_sends_secret(&local.0, &remote.0),
        "fixture: git push sends the secret to the real remote"
    );
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a repository core.sshCommand pointed the push gate's base at a decoy and hid a secret"
    );
}

// HIGH (new in round 5): every read runs at `rev-parse --show-toplevel`, and `core.worktree` in the repository's config
// sets that to any folder. Pointed at a clean clone, the guard reads the clone's HEAD and history while `git push` in
// the project sends the project's own HEAD.
#[test]
fn r5_h3_core_worktree_does_not_point_the_guard_at_another_repository() {
    let (local, remote) = pushed("worktree");
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    commit_all(&local.0, "config");
    let scratch = temp("worktree-scratch");
    let decoy = scratch.0.join("decoy");
    git(
        &scratch.0,
        &[
            "clone",
            "-q",
            remote.0.to_str().unwrap(),
            decoy.to_str().unwrap(),
        ],
    );
    git(
        &local.0,
        &["config", "core.worktree", decoy.to_str().unwrap()],
    );
    assert!(
        push_sends_secret(&local.0, &remote.0),
        "fixture: git push from the project still sends the project's HEAD"
    );
    assert!(
        gate_outgoing(&local.0).is_err(),
        "core.worktree pointed the push gate at a clean clone and hid the project's secret"
    );
}

// MEDIUM (the shell push): a tag may name a blob or a tree. `rev-list` lists no commit for either, so the pre-push check
// passes a push of `git tag leak <blob>` that sends the secret file to the remote.
#[test]
fn r5_m1_a_tag_that_names_a_blob_is_checked() {
    let (local, _remote) = pushed("blobtag");
    let blob_file = local.0.join("blob.txt");
    fs::write(&blob_file, secret_line()).unwrap();
    let blob = git(
        &local.0,
        &["hash-object", "-w", blob_file.to_str().unwrap()],
    )
    .trim()
    .to_string();
    fs::remove_file(&blob_file).unwrap();
    let stdin = format!("refs/tags/leak {blob} refs/tags/leak {}\n", "0".repeat(40));
    assert!(
        pre_push_stdin_check(&local.0, "origin", &stdin).is_err(),
        "a tag naming a blob with a secret passed the pre-push check"
    );
}

// MEDIUM (the app's push): `push.followTags=true` in the repository's config makes the app's
// `git push <remote> HEAD:refs/heads/<branch>` also send annotated tags, whose messages the gate never reads.
#[test]
fn r5_m2_the_apps_push_does_not_send_an_unchecked_tag_message() {
    let (local, remote) = pushed("followtags");
    write(&local.0, "src/app.txt", b"shipped\n");
    commit_all(&local.0, "app");
    git(
        &local.0,
        &["tag", "-a", "v9", "-m", &format!("release {}", fake_key())],
    );
    git(&local.0, &["config", "push.followTags", "true"]);
    let pushed = crate::fs::git_push_for(&local.0);
    let tag = git_ok(&remote.0, &["cat-file", "-p", "refs/tags/v9"]).unwrap_or_default();
    assert!(
        pushed.is_err() || !tag.contains("sk-ant-"),
        "the app's push sent an annotated tag whose message holds a secret"
    );
}

// MEDIUM (the app's push): `push.recurseSubmodules=on-demand` in the repository's config makes the app's push also push
// a submodule's new commits, which the gate never reads.
#[test]
fn r5_m3_the_apps_push_does_not_push_an_unchecked_submodule() {
    let sub_remote = temp("sub-remote");
    git(&sub_remote.0, &["init", "-q", "--bare", "-b", "main"]);
    let seed = temp("sub-seed");
    git(&seed.0, &["init", "-q", "-b", "main"]);
    configure(&seed.0);
    write(&seed.0, "s.txt", b"s\n");
    commit_all(&seed.0, "s");
    git(
        &seed.0,
        &["push", "-q", sub_remote.0.to_str().unwrap(), "main"],
    );
    let (local, _remote) = pushed("submodule");
    git(&local.0, &["config", "protocol.file.allow", "always"]);
    git(
        &local.0,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub_remote.0.to_str().unwrap(),
            "sub",
        ],
    );
    commit_all(&local.0, "add sub");
    git(&local.0, &["push", "-q", "origin", "main"]);
    let sub = local.0.join("sub");
    configure(&sub);
    git(&sub, &["checkout", "-q", "main"]);
    write(&sub, "src/config.rs", secret_line().as_bytes());
    commit_all(&sub, "config");
    commit_all(&local.0, "bump sub");
    git(&local.0, &["config", "push.recurseSubmodules", "on-demand"]);
    let pushed = crate::fs::git_push_for(&local.0);
    let sent = git_ok(&sub_remote.0, &["show", "main:src/config.rs"]).unwrap_or_default();
    assert!(
        pushed.is_err() || !sent.contains("sk-ant-"),
        "the app's push pushed a submodule commit with a secret that the gate never read"
    );
}

// MEDIUM (land): the land path's text is `git diff --cached --text` run with the checkout's own config, not through
// guard_git. `color.diff=always` (a worker checkout shares the project's .git/config) wraps every line in colour codes,
// so no hunk is recognised and a secret lands in the project unchecked (N1's class, on the path round 4 did not move).
#[test]
fn r5_m4_colour_config_does_not_hide_a_secret_from_the_land_check() {
    let root = temp("land-colour");
    let project = root.0.join("tally");
    fs::create_dir_all(&project).unwrap();
    git(&project, &["init", "-q", "-b", "main"]);
    configure(&project);
    write(&project, "a.txt", b"one\n");
    commit_all(&project, "start");
    let copy = root.0.join("tally-worktrees").join("mc-1");
    git(
        &project,
        &["worktree", "add", "-q", "--detach", copy.to_str().unwrap()],
    );
    write(&copy, "src/config.rs", secret_line().as_bytes());
    let project = crate::fs::canonical(&project).unwrap();
    let copy = crate::fs::canonical(&copy).unwrap();
    assert!(
        crate::land::land(&copy, &project).is_err(),
        "control: without the colour setting the land check refuses the secret"
    );
    git(&copy, &["config", "color.diff", "always"]);
    let landed = crate::land::land(&copy, &project);
    let leaked = fs::read_to_string(project.join("src/config.rs"))
        .map(|text| text.contains("sk-ant-"))
        .unwrap_or(false);
    assert!(
        !leaked,
        "color.diff=always hid a secret from the land check: {:?}",
        landed.map(|l| l.outcome)
    );
}

// HIGH: the simplest form of the same hole, with no URL rewriting at all. A remote may have several push URLs; `git
// push` pushes to every one, but `git remote get-url --push` prints only the first. A decoy listed first is the only
// remote the guard asks, and the real remote listed second receives the secret.
#[test]
fn r5_h2c_a_second_push_url_is_checked_too() {
    let (local, remote) = pushed("pushurls");
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    commit_all(&local.0, "config");
    let scratch = temp("pushurls-scratch");
    let decoy = decoy_holding(&local.0, &remote.0, &scratch.0);
    git(
        &local.0,
        &[
            "config",
            "--add",
            "remote.origin.pushurl",
            decoy.to_str().unwrap(),
        ],
    );
    git(
        &local.0,
        &[
            "config",
            "--add",
            "remote.origin.pushurl",
            remote.0.to_str().unwrap(),
        ],
    );
    assert!(
        push_sends_secret(&local.0, &remote.0),
        "fixture: git push sends the secret to the second push URL"
    );
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a decoy first push URL hid a secret that git push sent to the second"
    );
}
