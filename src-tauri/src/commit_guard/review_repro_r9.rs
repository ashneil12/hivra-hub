//! Review of PR #227 (WP-200), round 9: red-first repros at 72c902789. Each test states what the guard must do and
//! fails on that head at the guard's own assertion (the fixture assertions pass).
//!
//! N1: round 9 treats a commit-graph in an alternate object store as untrusted, but it reads only the first level of
//! `objects/info/alternates`, and a quoted line there (`"<path>"`, which git unquotes) is taken as a relative path.
//! `git push` loads every alternate, nested ones too, and walks the first commit-graph it finds. The round 8 M2 forged
//! graph moved two alternates down (or behind a quoted line) is never seen by the guard, `git commit-graph verify`
//! does not read it, and a default shell push still sends the key past the pre-push check. (MEDIUM: the hook path)
//!
//! H1: the push check asks each push URL from outside the repository, with no repository config, but `git push`
//! still runs `remote.<name>.receivepack`, which the repository config sets. With `remote.origin.url` naming a local
//! decoy that already holds the key commit and `remote.origin.receivepack = git-receive-pack '<real>' #`, the guard
//! asks the decoy, counts the key commit as already upstream and scans nothing, and the app's own push (the shell `#`
//! drops the decoy path) writes the key to the real remote. Static `.git/config` only, no script. For a GitHub remote
//! the same key can run `ssh git@github.com git-receive-pack '<repo>' #`. The pre-push hook is given the decoy URL as
//! `$2` and passes too. Present since the round 5 design, not new in round 9. (HIGH: the app's push, PR and delivery)

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
    let path = std::env::temp_dir().join(format!("cg-rr9-{tag}-{}-{nanos}", std::process::id()));
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

/// The round 8 M2 setup: a key blob only the forged commit-graph names, with that graph in `local`'s own object store.
/// Returns the local repo, its remote, the remote's tip, the pushed tip and the key blob.
fn forged(tag: &str) -> (Dir, Dir, String, String, String) {
    let (local, remote) = pushed(tag);
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
    (local, remote, base, tip, blob)
}

/// Moves `local`'s forged graph into a fresh bare store and returns that store's `objects` folder.
fn graph_store(local: &Path, tag: &str) -> (Dir, PathBuf) {
    let store = temp(tag);
    git(&store.0, &["init", "-q", "--bare"]);
    let objects = store.0.join("objects");
    fs::rename(
        local.join(".git/objects/info/commit-graph"),
        objects.join("info/commit-graph"),
    )
    .unwrap();
    (store, objects)
}

/// A default shell push to a copy of `remote` delivers `blob`, then the pre-push check is asked about the same push.
fn shell_push_then_check(
    local: &Path,
    remote: &Path,
    tag: &str,
    base: &str,
    tip: &str,
    blob: &str,
) -> Result<(), String> {
    assert!(
        !local.join(".git/objects/info/commit-graph").exists(),
        "fixture: the repository has no commit-graph of its own"
    );
    let witness = temp(tag);
    let witness_git = witness.0.join("w.git");
    git(
        &witness.0,
        &[
            "clone",
            "-q",
            "--bare",
            remote.to_str().unwrap(),
            witness_git.to_str().unwrap(),
        ],
    );
    git(
        local,
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
        has_object(&witness_git, blob),
        "fixture: a default shell push sends the key through the alternate's graph"
    );
    let stdin = format!("refs/heads/main {tip} refs/heads/main {base}\n");
    super::pre_push_stdin_check(local, "origin", &stdin)
}

/// N1. The forged graph two alternates down: `local` -> `hop1` -> `hop2`.
#[test]
fn rr9_n1_a_commit_graph_two_alternates_down_is_not_trusted() {
    let (local, remote, base, tip, blob) = forged("n1");
    let (_hop2, hop2_objects) = graph_store(&local.0, "n1-hop2");
    let hop1 = temp("n1-hop1");
    git(&hop1.0, &["init", "-q", "--bare"]);
    fs::write(
        hop1.0.join("objects/info/alternates"),
        format!("{}\n", hop2_objects.display()),
    )
    .unwrap();
    fs::write(
        local.0.join(".git/objects/info/alternates"),
        format!("{}\n", hop1.0.join("objects").display()),
    )
    .unwrap();
    let checked = shell_push_then_check(&local.0, &remote.0, "n1-witness", &base, &tip, &blob);
    assert!(
        checked.is_err(),
        "the pre-push check passed a push that sends a key through a nested alternate's graph: {checked:?}"
    );
}

/// N1b. The forged graph behind one quoted alternates line, which git unquotes. A Windows path would need its
/// backslashes escaped in the quoted line.
#[cfg(unix)]
#[test]
fn rr9_n1b_a_commit_graph_behind_a_quoted_alternates_line_is_not_trusted() {
    let (local, remote, base, tip, blob) = forged("n1b");
    let (_store, objects) = graph_store(&local.0, "n1b-store");
    fs::write(
        local.0.join(".git/objects/info/alternates"),
        format!("\"{}\"\n", objects.display()),
    )
    .unwrap();
    let checked = shell_push_then_check(&local.0, &remote.0, "n1b-witness", &base, &tip, &blob);
    assert!(
        checked.is_err(),
        "the pre-push check passed a push that sends a key through a quoted alternate's graph: {checked:?}"
    );
}

/// H1. The guard asks the decoy that `remote.origin.url` names; `remote.origin.receivepack` takes the app's push to the
/// real remote. The app's push must refuse, and the key commit must not reach the real remote.
#[cfg(unix)]
#[test]
fn rr9_h1_a_receivepack_takes_the_app_push_past_the_decoy_the_guard_asked() {
    let real = temp("h1-real");
    git(&real.0, &["init", "-q", "--bare", "-b", "main"]);
    let local = temp("h1");
    git(&local.0, &["init", "-q", "-b", "main"]);
    configure(&local.0);
    fs::write(local.0.join("README.md"), b"hello\n").unwrap();
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "base"]);
    git(&local.0, &["push", "-q", real.0.to_str().unwrap(), "main"]);
    let secret = format!("const KEY: &str = \"{}\";\n", fake_key());
    fs::write(local.0.join("key.rs"), secret.as_bytes()).unwrap();
    git(&local.0, &["add", "key.rs"]);
    git(&local.0, &["commit", "-q", "-m", "key"]);
    let sha = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    let decoy = temp("h1-decoy");
    git(&decoy.0, &["init", "-q", "--bare", "-b", "main"]);
    git(
        &local.0,
        &[
            "push",
            "-q",
            "--no-verify",
            decoy.0.to_str().unwrap(),
            "main",
        ],
    );
    git(
        &local.0,
        &["remote", "add", "origin", decoy.0.to_str().unwrap()],
    );
    git(
        &local.0,
        &[
            "config",
            "remote.origin.receivepack",
            &format!("git-receive-pack '{}' #", real.0.display()),
        ],
    );
    assert!(
        has_object(&decoy.0, &sha) && !has_object(&real.0, &sha),
        "fixture: only the decoy holds the key commit before the push"
    );

    let pushed = crate::fs::git_push_for(&local.0);
    let leaked = has_object(&real.0, &sha);
    assert!(
        pushed.is_err() && !leaked,
        "the app push sent the key commit to the real remote past the guard (key on the real remote: {leaked}): {pushed:?}"
    );
}

/// H1, the pre-push hook: git gives it the decoy URL as `$2`.
#[cfg(unix)]
#[test]
fn rr9_h1b_the_pre_push_check_refuses_a_remote_with_its_own_receivepack() {
    let real = temp("h1b-real");
    git(&real.0, &["init", "-q", "--bare", "-b", "main"]);
    let local = temp("h1b");
    git(&local.0, &["init", "-q", "-b", "main"]);
    configure(&local.0);
    fs::write(local.0.join("README.md"), b"hello\n").unwrap();
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "base"]);
    git(&local.0, &["push", "-q", real.0.to_str().unwrap(), "main"]);
    let base = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    let secret = format!("const KEY: &str = \"{}\";\n", fake_key());
    fs::write(local.0.join("key.rs"), secret.as_bytes()).unwrap();
    git(&local.0, &["add", "key.rs"]);
    git(&local.0, &["commit", "-q", "-m", "key"]);
    let sha = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    let decoy = temp("h1b-decoy");
    git(&decoy.0, &["init", "-q", "--bare", "-b", "main"]);
    git(
        &local.0,
        &[
            "push",
            "-q",
            "--no-verify",
            decoy.0.to_str().unwrap(),
            "main",
        ],
    );
    let decoy_url = decoy.0.to_str().unwrap().to_string();
    git(&local.0, &["remote", "add", "origin", &decoy_url]);
    git(
        &local.0,
        &[
            "config",
            "remote.origin.receivepack",
            &format!("git-receive-pack '{}' #", real.0.display()),
        ],
    );
    // Fixture: a plain `git push origin` (no hook) writes the key commit to the real remote.
    let witness = temp("h1b-witness");
    let witness_git = witness.0.join("w.git");
    git(
        &witness.0,
        &[
            "clone",
            "-q",
            "--bare",
            real.0.to_str().unwrap(),
            witness_git.to_str().unwrap(),
        ],
    );
    let probe = temp("h1b-probe");
    git(&probe.0, &["clone", "-q", local.0.to_str().unwrap(), "p"]);
    let probe_repo = probe.0.join("p");
    configure(&probe_repo);
    git(&probe_repo, &["remote", "set-url", "origin", &decoy_url]);
    git(
        &probe_repo,
        &[
            "config",
            "remote.origin.receivepack",
            &format!("git-receive-pack '{}' #", witness_git.display()),
        ],
    );
    git(
        &probe_repo,
        &[
            "push",
            "-q",
            "--no-verify",
            "origin",
            "HEAD:refs/heads/main",
        ],
    );
    assert!(
        has_object(&witness_git, &sha),
        "fixture: git push origin delivers the key commit to the receivepack's repository"
    );

    let stdin = format!("refs/heads/main {sha} refs/heads/main {base}\n");
    let checked = super::pre_push_in(
        &local.0,
        &super::objects::open_repo(&local.0).unwrap(),
        "origin",
        Some(&decoy_url),
        &stdin,
    );
    assert!(
        checked.is_err(),
        "the pre-push check passed a push whose receivepack sends the key to another repository: {checked:?}"
    );
}
