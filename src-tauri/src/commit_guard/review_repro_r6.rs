//! Review of PR #227 (WP-200), round 6: red-first repros at 54145260c. Each test states what the guard must do; each
//! fails on the head it was written against, at the guard's own assertion (the fixture assertions pass).
//!
//! Two tests run their body in a child copy of this test binary, so a planted temp folder or a temporary global git
//! config never reaches the other tests. The inner halves are `#[ignore]` and do nothing unless the outer half started
//! them.

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
    let path = std::env::temp_dir().join(format!("cg-r6-{tag}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    Dir(dunce::canonicalize(&path).unwrap())
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
        ("push.negotiate", "false"),
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

/// A bare repository holding the local HEAD under refs/heads/main, cloned from `remote`: the decoy.
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

/// Whether the remote ends up with the secret in `path` when git pushes HEAD the way the app does. The probe ref is
/// removed after.
fn push_sends_secret_in(local: &Path, remote: &Path, path: &str) -> bool {
    git(local, &["push", "-q", "origin", "HEAD:refs/heads/probe"]);
    let sent = git_ok(remote, &["show", &format!("probe:{path}")]).unwrap_or_default();
    git(remote, &["update-ref", "-d", "refs/heads/probe"]);
    git(remote, &["gc", "-q", "--prune=now"]);
    sent.contains("sk-ant-")
}

fn push_sends_secret(local: &Path, remote: &Path) -> bool {
    push_sends_secret_in(local, remote, "src/config.rs")
}

/// The test's name as the harness lists it (without the crate name).
fn test_name(name: &str) -> String {
    let module = module_path!();
    let module = module
        .split_once("::")
        .map(|(_, rest)| rest)
        .unwrap_or(module);
    format!("{module}::{name}")
}

/// Runs the `#[ignore]`d inner test `name` in a child copy of this test binary with `envs` set. Returns whether it
/// passed, and its output.
fn run_child(name: &str, envs: &[(&str, &Path)]) -> (bool, String) {
    let exe = std::env::current_exe().expect("the test binary");
    let mut cmd = Command::new(exe);
    cmd.args([
        test_name(name).as_str(),
        "--exact",
        "--ignored",
        "--test-threads=1",
        "--nocapture",
    ])
    .env("CG_R6_CHILD", "1");
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let out = cmd.output().expect("the child test runs");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.success() && text.contains("1 passed"), text)
}

fn in_child() -> bool {
    std::env::var_os("CG_R6_CHILD").is_some()
}

// HIGH (H1's structure, new hole): a commit that turns a gitlink into a regular file with the same object id is skipped.
// `scan_commit` skips every 160000 entry, and then treats `old_sha == new_sha` as "the same as the parent", although the
// parent had a submodule pointer (never pushed, never read) and the commit has a file. A gitlink may name any object,
// so commit A adds `src/config.rs` as a gitlink to the secret blob and commit B changes only its mode to 100644: B's
// diff-tree line is `:160000 100644 <X> <X> T`. `git push` sends the blob with B; the gate reads nothing. The file is
// not in `scan.added` either, so an agent file or a secret-shaped file name passes the same way.
#[test]
fn r6_h1_a_gitlink_turned_into_a_file_is_scanned() {
    let (local, remote) = pushed("gitlink");
    let staged = local.0.join("blob.txt");
    fs::write(&staged, secret_line()).unwrap();
    let blob = git(&local.0, &["hash-object", "-w", staged.to_str().unwrap()])
        .trim()
        .to_string();
    fs::remove_file(&staged).unwrap();
    git(
        &local.0,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{blob},src/config.rs"),
        ],
    );
    git(&local.0, &["commit", "-q", "-m", "add a submodule pointer"]);
    git(
        &local.0,
        &[
            "update-index",
            "--cacheinfo",
            &format!("100644,{blob},src/config.rs"),
        ],
    );
    git(&local.0, &["commit", "-q", "-m", "vendor it"]);
    assert!(
        push_sends_secret(&local.0, &remote.0),
        "fixture: git push sends the secret file"
    );
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a gitlink turned into a regular file (same object id) carried a secret file past the push gate"
    );
}

// HIGH (H2, not closed): the outside `ls-remote` runs in `<temp>/cg-ls-<pid>-<nanos>` with GIT_CEILING_DIRECTORIES set
// to that same folder. Git only stops at a ceiling that is a proper ancestor of the current folder, so it walks up and
// uses a repository at `<temp>/.git` (on a Mac `$TMPDIR`, which every agent can write). That repository's
// `url.<decoy>.insteadOf = <real>` points the base at a decoy that advertises the secret commit, exactly r5's h2.
#[test]
fn r6_h2_a_repository_above_the_ls_remote_folder_does_not_point_the_base_at_a_decoy() {
    let planted = temp("planted-tmp");
    let (passed, output) = run_child(
        "r6_h2_inner_planted_temp_folder",
        &[("TMPDIR", planted.0.as_path())],
    );
    assert!(
        passed,
        "a repository planted in the temp folder rewrote the guard's ls-remote and hid a secret:\n{output}"
    );
}

#[test]
#[ignore = "run by r6_h2_a_repository_above_the_ls_remote_folder_does_not_point_the_base_at_a_decoy in a child"]
fn r6_h2_inner_planted_temp_folder() {
    if !in_child() {
        return;
    }
    let tmp = crate::fs::canonical(std::env::temp_dir()).unwrap();
    assert!(
        tmp.to_string_lossy().contains("cg-r6-planted-tmp"),
        "only ever plant in the outer test's own folder: {}",
        tmp.display()
    );
    let (local, remote) = pushed("planted");
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    commit_all(&local.0, "config");
    let scratch = temp("planted-scratch");
    let decoy = decoy_holding(&local.0, &remote.0, &scratch.0);
    assert!(
        gate_outgoing(&local.0).is_err(),
        "control: with nothing planted the push gate refuses the secret"
    );
    git(&tmp, &["init", "-q"]);
    git(
        &tmp,
        &[
            "config",
            &format!("url.{}.insteadOf", decoy.to_str().unwrap()),
            remote.0.to_str().unwrap(),
        ],
    );
    assert!(
        push_sends_secret(&local.0, &remote.0),
        "fixture: git push sends the secret to the real remote"
    );
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a repository at the temp folder pointed the push gate's base at a decoy and hid a secret"
    );
}

// HIGH (H3, not closed): `open_repo` re-implements discovery and trims the `gitdir:` line; git does not. Git strips
// only the trailing CR/LF and keeps spaces, so `gitdir: gd \n` is the folder "gd " to `git push`, and "gd" to the
// guard. With the real git dir moved to "gd " and a clean bare clone at "gd", the guard reads the clone's HEAD and
// history while the push sends the project's.
#[test]
fn r6_h3_a_gitdir_line_with_a_trailing_space_does_not_point_the_guard_at_a_decoy() {
    let (local, remote) = pushed("gitdir-space");
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    commit_all(&local.0, "config");
    assert!(
        gate_outgoing(&local.0).is_err(),
        "control: with a plain .git folder the push gate refuses the secret"
    );
    fs::rename(local.0.join(".git"), local.0.join("gd ")).unwrap();
    git(
        &local.0,
        &[
            "clone",
            "-q",
            "--bare",
            remote.0.to_str().unwrap(),
            local.0.join("gd").to_str().unwrap(),
        ],
    );
    fs::write(local.0.join(".git"), "gitdir: gd \n").unwrap();
    assert!(
        push_sends_secret(&local.0, &remote.0),
        "fixture: git push from the project still sends the project's HEAD"
    );
    assert!(
        gate_outgoing(&local.0).is_err(),
        "a `gitdir: gd ` line pointed the push gate at a clean clone and hid the project's secret"
    );
}

// MEDIUM (M4's other half): the guard resolves the push URL with GIT_CONFIG_GLOBAL=/dev/null, but `git push` and the
// guard's own `ls-remote` keep the global config. Two `url.*` lines in ~/.gitconfig (an agent can run
// `git config --global`; no deny rule holds it) send ls-remote of the configured name to a decoy and the push to the
// real remote. Same as r5's h2, moved from .git/config to the global file.
#[test]
fn r6_m4_global_url_rewrites_do_not_point_the_base_at_a_decoy() {
    let home = temp("global-config");
    let global = home.0.join("gitconfig");
    let (passed, output) = run_child(
        "r6_m4_inner_global_url_rewrites",
        &[("GIT_CONFIG_GLOBAL", global.as_path())],
    );
    assert!(
        passed,
        "global url rewrites pointed the guard's base at a decoy and hid a secret:\n{output}"
    );
}

#[test]
#[ignore = "run by r6_m4_global_url_rewrites_do_not_point_the_base_at_a_decoy in a child"]
fn r6_m4_inner_global_url_rewrites() {
    if !in_child() {
        return;
    }
    let global =
        PathBuf::from(std::env::var_os("GIT_CONFIG_GLOBAL").expect("set by the outer test"));
    assert!(
        global.to_string_lossy().contains("cg-r6-global-config"),
        "only ever write the outer test's own file: {}",
        global.display()
    );
    let (local, remote) = pushed("global");
    write(&local.0, "src/config.rs", secret_line().as_bytes());
    commit_all(&local.0, "config");
    let scratch = temp("global-scratch");
    let decoy = decoy_holding(&local.0, &remote.0, &scratch.0);
    assert!(
        gate_outgoing(&local.0).is_err(),
        "control: with an empty global config the push gate refuses the secret"
    );
    git(&local.0, &["config", "remote.origin.url", "hivra-alias:"]);
    let file = global.to_str().unwrap();
    git(
        &scratch.0,
        &[
            "config",
            "--file",
            file,
            &format!("url.{}.insteadOf", decoy.to_str().unwrap()),
            "hivra-alias:",
        ],
    );
    git(
        &scratch.0,
        &[
            "config",
            "--file",
            file,
            &format!("url.{}.pushInsteadOf", remote.0.to_str().unwrap()),
            "hivra-alias:",
        ],
    );
    assert!(
        push_sends_secret(&local.0, &remote.0),
        "fixture: git push sends the secret to the real remote"
    );
    assert!(
        gate_outgoing(&local.0).is_err(),
        "global url rewrites pointed the push gate's base at a decoy and hid a secret"
    );
}

/// A project with one commit and a worker copy where land.rs expects it (`<parent>/<name>-worktrees/<copy>`).
fn land_fixture(tag: &str) -> (Dir, PathBuf, PathBuf) {
    let root = temp(tag);
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
    let project = crate::fs::canonical(&project).unwrap();
    let copy = crate::fs::canonical(&copy).unwrap();
    (root, project, copy)
}

fn project_has_secret(project: &Path) -> bool {
    fs::read_to_string(project.join("src/config.rs"))
        .map(|text| text.contains("sk-ant-"))
        .unwrap_or(false)
}

// MEDIUM (M3, partly open): land now scans the staged blobs, but what it applies is `git diff --cached --binary`, run
// with the checkout's own config and without `--no-textconv`. A textconv driver (`.git/info/attributes` plus
// `diff.<driver>.textconv` in the shared .git/config) rewrites the patch text: the scanned blob says PLACEHOLDER and the
// project receives the key.
#[test]
fn r6_m3_a_textconv_driver_does_not_land_text_the_check_never_read() {
    let (_root, project, copy) = land_fixture("land-textconv");
    write(
        &copy,
        "src/config.rs",
        b"const KEY: &str = \"PLACEHOLDER\";\n",
    );
    write(
        &project,
        ".git/info/attributes",
        b"src/config.rs diff=reveal\n",
    );
    git(
        &copy,
        &[
            "config",
            "diff.reveal.textconv",
            &format!("sed s/PLACEHOLDER/{}/", fake_key()),
        ],
    );
    let landed = crate::land::land(&copy, &project);
    assert!(
        !project_has_secret(&project),
        "a textconv driver landed a secret the check never read: {:?}",
        landed.map(|l| l.outcome)
    );
}

// MEDIUM (M3, partly open): when the patch does not apply, land's three-way path (`merged`) writes the worker's
// working-tree file, not the blob the check read. A clean filter in the shared config makes the staged blob differ from
// the file on disk, so the check reads `xx-ant-...` and the project receives `sk-ant-...`. Moving the copy's start back
// (or any clash) is enough to take the three-way path; here the project already has the copy's other change.
#[test]
fn r6_m3b_the_three_way_land_writes_only_what_the_check_read() {
    let (_root, project, copy) = land_fixture("land-merged");
    write(&project, "a.txt", b"one\ntwo\n");
    commit_all(&project, "project moved");
    write(&copy, "a.txt", b"one\ntwo\n");
    write(&copy, "src/config.rs", secret_line().as_bytes());
    assert!(
        crate::land::land(&copy, &project).is_err() && !project_has_secret(&project),
        "control: without the filter the land check refuses the secret"
    );
    write(
        &project,
        ".git/info/attributes",
        b"src/config.rs filter=hide\n",
    );
    git(
        &copy,
        &["config", "filter.hide.clean", "sed s/sk-ant-/xx-ant-/"],
    );
    let landed = crate::land::land(&copy, &project);
    assert!(
        !project_has_secret(&project),
        "the three-way land wrote a working-tree secret the check never read: {:?}",
        landed.map(|l| (l.outcome, l.why))
    );
}
