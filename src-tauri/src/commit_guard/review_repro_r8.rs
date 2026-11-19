//! Review of PR #227 (WP-200), round 8: red-first repros at 05f720a74. Each test states what the guard must do and
//! fails on that head at the guard's own assertion (the fixture assertions pass).
//!
//! M1: round 8 resolves the push URL with the system config hidden (`GIT_CONFIG_NOSYSTEM` and a blank
//! `GIT_CONFIG_SYSTEM`), but the app's push still reads the system config. A system `url.<real>.insteadOf = <decoy>`
//! (Homebrew's `/opt/homebrew/etc/gitconfig` is owned by the user) sends `git push origin` to the real remote while
//! the guard asks the decoy which commits are already upstream. The decoy advertises the key commit, so nothing is
//! scanned, and the app push puts the key on the real remote. Round 7 followed the system rewrite here. (MEDIUM)
//!
//! M2: the pre-push hook compares the blobs of a plain `rev-list --objects` walk with the same walk using the
//! commit-graph. `git push` itself walks trees with `pack.useSparse` (on by default since git 2.27), which only marks
//! a tree as already on the remote along matching paths. A commit-graph that names, for the remote's tip, a tree that
//! holds the pushed commit's (also graph-named) tree two folders down makes the guard's graph walk (not sparse) count
//! all of it as already on the remote, so no blob is new and the check passes, while a default shell push sends the key.
//! Comparing every object id (not only blobs) would not catch this one either: the graph walk lists only the commit.
//! (MEDIUM: the hook path, which round 8 says it covers)

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
    let path = std::env::temp_dir().join(format!("cg-rr8-{tag}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    Dir(dunce::canonicalize(&path).unwrap())
}

fn git_in(dir: &Path, args: &[&str], input: Option<&[u8]>) -> String {
    use std::io::Write;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("git runs");
    {
        let mut stdin = child.stdin.take().unwrap();
        if let Some(bytes) = input {
            stdin.write_all(bytes).unwrap();
        }
    }
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn git(dir: &Path, args: &[&str]) -> String {
    git_in(dir, args, None)
}

fn has_object(dir: &Path, sha: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["cat-file", "-e", sha])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn configure(dir: &Path) {
    for (key, value) in [
        ("user.email", "guard@example.test"),
        ("user.name", "Guard Test"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
        ("push.negotiate", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
}

/// A local repo whose `origin` (a bare repo) already holds one commit.
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
    fs::write(local.0.join("README.md"), b"hello\n").unwrap();
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "base"]);
    git(&local.0, &["push", "-q", "-u", "origin", "main"]);
    (local, remote)
}

/// SHA-1, for the commit-graph trailer.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[4 * i],
                block[4 * i + 1],
                block[4 * i + 2],
                block[4 * i + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// Rewrites the root tree the commit-graph stores for each `(commit, tree)` pair, then fixes the trailer.
fn graph_names_trees(git_dir: &Path, pairs: &[(&str, &str)]) {
    let path = git_dir.join("objects/info/commit-graph");
    let mut data = fs::read(&path).expect("a commit-graph was written");
    assert_eq!(&data[..4], b"CGPH");
    assert_eq!(data[5], 1, "a SHA-1 graph");
    let chunks = data[6] as usize;
    let mut oidl = 0usize;
    let mut cdat = 0usize;
    for i in 0..=chunks {
        let at = 8 + i * 12;
        let id = &data[at..at + 4];
        let mut off = [0u8; 8];
        off.copy_from_slice(&data[at + 4..at + 12]);
        let off = u64::from_be_bytes(off) as usize;
        if id == b"OIDL" {
            oidl = off;
        } else if id == b"CDAT" {
            cdat = off;
        }
    }
    assert!(oidl > 0 && cdat > oidl, "graph chunks found");
    let count = (cdat - oidl) / 20;
    for (commit, tree) in pairs {
        let want = unhex(commit);
        let index = (0..count)
            .find(|i| data[oidl + i * 20..oidl + (i + 1) * 20] == want[..])
            .expect("the commit is in the graph");
        let entry = cdat + index * 36;
        data[entry..entry + 20].copy_from_slice(&unhex(tree));
    }
    let body = data.len() - 20;
    let sum = sha1(&data[..body]);
    data[body..].copy_from_slice(&sum);
    fs::remove_file(&path).unwrap();
    fs::write(&path, data).unwrap();
}

#[test]
fn rr8_sha1_matches_a_known_digest() {
    let hex: String = sha1(b"abc").iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
}

/// M2. A default shell push walks trees sparsely, so it sends a blob that the plain walk the hook check uses counts as
/// already on the remote through a graph-named tree. The hook check must refuse this push.
#[test]
fn rr8_m2_a_sparse_shell_push_sends_a_key_the_graph_walk_counted_as_upstream() {
    let (local, remote) = pushed("m2");
    let base = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    fs::write(local.0.join("ok.txt"), b"ok\n").unwrap();
    git(&local.0, &["add", "ok.txt"]);
    git(&local.0, &["commit", "-q", "-m", "ok"]);
    let tip = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    let secret = format!("const KEY: &str = \"{}\";\n", fake_key());
    let blob = git_in(
        &local.0,
        &["hash-object", "-w", "--stdin"],
        Some(secret.as_bytes()),
    )
    .trim()
    .to_string();
    let readme = git(&local.0, &["rev-parse", &format!("{base}:README.md")])
        .trim()
        .to_string();
    let ok = git(&local.0, &["rev-parse", &format!("{tip}:ok.txt")])
        .trim()
        .to_string();
    let tip_tree = git(&local.0, &["rev-parse", &format!("{tip}^{{tree}}")])
        .trim()
        .to_string();
    // The tip's tree per the graph: its real files, its real tree under orig/ (so the remote accepts the push), and
    // the key.
    let shown = git_in(
        &local.0,
        &["mktree"],
        Some(
            format!(
                "100644 blob {readme}\tREADME.md\n100644 blob {ok}\tok.txt\n040000 tree {tip_tree}\torig\n100644 blob {blob}\tkey.rs\n"
            )
            .as_bytes(),
        ),
    )
    .trim()
    .to_string();
    // The remote tip's tree per the graph: that same tree two folders down.
    let inner = git_in(
        &local.0,
        &["mktree"],
        Some(format!("040000 tree {shown}\tb\n").as_bytes()),
    )
    .trim()
    .to_string();
    let base_shown = git_in(
        &local.0,
        &["mktree"],
        Some(format!("100644 blob {readme}\tREADME.md\n040000 tree {inner}\ta\n").as_bytes()),
    )
    .trim()
    .to_string();
    git(&local.0, &["commit-graph", "write", "--reachable"]);
    graph_names_trees(
        &local.0.join(".git"),
        &[
            (base.as_str(), base_shown.as_str()),
            (tip.as_str(), shown.as_str()),
        ],
    );
    assert!(
        !git(&local.0, &["ls-tree", "-r", &tip]).contains(&blob),
        "fixture: the raw commit does not hold the key"
    );

    // Fixture: a plain shell push (commit-graph on, sparse tree walk on, no hook) to a copy of the remote delivers the
    // key, and that remote accepts the push.
    let witness = temp("m2-witness");
    let witness_git = witness.0.join("w.git");
    git(
        &witness.0,
        &[
            "clone",
            "-q",
            "--bare",
            remote.0.to_str().unwrap(),
            witness_git.to_str().unwrap(),
        ],
    );
    git(
        &local.0,
        &[
            "-c",
            "core.commitGraph=true",
            "-c",
            "pack.useSparse=true",
            "-c",
            "pack.useBitmaps=false",
            "push",
            "-q",
            witness_git.to_str().unwrap(),
            &format!("{tip}:refs/heads/main"),
        ],
    );
    assert!(
        has_object(&witness_git, &blob),
        "fixture: a default shell push sends the key"
    );

    let stdin = format!("refs/heads/main {tip} refs/heads/main {base}\n");
    let checked = super::pre_push_stdin_check(&local.0, "origin", &stdin);
    assert!(
        checked.is_err(),
        "the pre-push check passed a push that sends a key it never read: {checked:?}"
    );
}

// Only the unix child test calls it; Windows CI builds tests with `-D warnings`.
#[cfg(unix)]
fn in_child() -> bool {
    std::env::var_os("CG_RR8_CHILD").is_some()
}

/// M1. The system config is set only in a child copy of this binary (`GIT_CONFIG_SYSTEM`), with an empty global file.
#[cfg(unix)]
#[test]
fn rr8_m1_a_system_url_rewrite_takes_the_app_push_past_the_remote_the_guard_asked() {
    let home = temp("m1-config");
    let system = home.0.join("system.gitconfig");
    let global = home.0.join("global.gitconfig");
    fs::write(&system, "").unwrap();
    fs::write(&global, "").unwrap();
    let exe = std::env::current_exe().expect("the test binary");
    // The lib harness lists this module without the `commit_guard::` prefix (same as the r7 child).
    let module = module_path!();
    let module = module
        .split_once("::")
        .map(|(_, rest)| rest)
        .unwrap_or(module);
    let filter = format!("{module}::rr8_m1_inner_system_url_rewrite");
    let out = Command::new(exe)
        .args([
            filter.as_str(),
            "--exact",
            "--ignored",
            "--test-threads=1",
            "--nocapture",
        ])
        .env("CG_RR8_CHILD", "1")
        .env("GIT_CONFIG_SYSTEM", &system)
        .env("GIT_CONFIG_GLOBAL", &global)
        .env_remove("GIT_CONFIG_NOSYSTEM")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .output()
        .expect("the child test runs");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.status.success() && text.contains("1 passed"),
        "the app push sent a key to a remote the guard never asked:\n{text}"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "run by rr8_m1_a_system_url_rewrite_takes_the_app_push_past_the_remote_the_guard_asked in a child"]
fn rr8_m1_inner_system_url_rewrite() {
    if !in_child() {
        return;
    }
    let system =
        PathBuf::from(std::env::var_os("GIT_CONFIG_SYSTEM").expect("set by the outer test"));
    let global =
        PathBuf::from(std::env::var_os("GIT_CONFIG_GLOBAL").expect("set by the outer test"));
    for path in [&system, &global] {
        assert!(
            path.to_string_lossy().contains("cg-rr8-m1-config"),
            "only ever write the outer test's own file: {}",
            path.display()
        );
    }
    let root = temp("m1-repo");
    let real = root.0.join("real.git");
    let decoy = root.0.join("decoy.git");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&decoy).unwrap();
    git(&real, &["init", "-q", "--bare", "-b", "main"]);
    git(&decoy, &["init", "-q", "--bare", "-b", "main"]);
    let local = root.0.join("local");
    fs::create_dir_all(&local).unwrap();
    git(&local, &["init", "-q", "-b", "main"]);
    configure(&local);
    fs::write(local.join("README.md"), b"hello\n").unwrap();
    git(&local, &["add", "-A"]);
    git(&local, &["commit", "-q", "-m", "base"]);
    fs::write(
        local.join("key.rs"),
        format!("const KEY: &str = \"{}\";\n", fake_key()),
    )
    .unwrap();
    git(&local, &["add", "key.rs"]);
    git(&local, &["commit", "-q", "-m", "key"]);
    let blob = git(&local, &["rev-parse", "HEAD:key.rs"])
        .trim()
        .to_string();
    // The decoy, a folder an agent can write, already holds the key commit.
    git(
        &local,
        &[
            "push",
            "-q",
            decoy.to_str().unwrap(),
            "HEAD:refs/heads/main",
        ],
    );
    git(
        &local,
        &["remote", "add", "origin", decoy.to_str().unwrap()],
    );
    // Only now does the system config send `origin` to the real remote.
    fs::write(
        &system,
        format!(
            "[url \"{}\"]\n\tinsteadOf = {}\n",
            real.display(),
            decoy.display()
        ),
    )
    .unwrap();
    assert_eq!(
        git(&local, &["remote", "get-url", "--push", "origin"]).trim(),
        real.to_str().unwrap(),
        "fixture: git push origin goes to the real remote"
    );
    assert!(
        !has_object(&real, &blob),
        "fixture: the real remote starts clean"
    );

    let result = crate::fs::git_push_for(&local);
    assert!(
        !has_object(&real, &blob),
        "the app push put a key on the remote git pushed to, after the guard asked the decoy: {result:?}"
    );
}
