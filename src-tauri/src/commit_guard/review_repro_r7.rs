//! Review of PR #227 (WP-200), round 7: red-first repros at 01bd6b2ae. Each test states what the guard must do and
//! fails on that head at the guard's own assertion (the fixture assertions pass).
//!
//! N1: the guard reads each commit's tree from the raw commit object (`diff-tree <parent> <commit>`), while the push's
//! `pack-objects` walks the commit-graph file, which also stores a root tree per commit and is trusted as a cache. A
//! commit-graph entry that names a different tree makes the push send that tree and its blobs, which the guard never
//! read. The remote accepts the push, because the real commit's tree is already there, and keeps the extra blob. (HIGH)
//!
//! N2: the landing patch is `git diff --cached`, which reads a stat-clean working-tree file instead of the staged
//! blob the check read. (MEDIUM)
//!
//! N3: `ls-remote` drops the system config, where Apple's and Homebrew's git keep `credential.helper=osxkeychain`, so a
//! clean push to a private https remote is refused. (MEDIUM, availability)

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
    let path = std::env::temp_dir().join(format!("cg-r7-{tag}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    Dir(crate::fs::canonical(&path).unwrap())
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

/// A local repo whose `origin` (a bare repo) already holds one commit.
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
        ("push.negotiate", "false"),
    ] {
        git(&local.0, &["config", key, value]);
    }
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

/// SHA-1, for the commit-graph trailer (git 2.43 does not check it on read; a later git might).
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

/// Rewrites the root tree that the commit-graph file stores for `commit`. The commit object itself is unchanged.
fn graph_names_tree(git_dir: &Path, commit: &str, tree: &str) {
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
    let want = unhex(commit);
    let index = (0..count)
        .find(|i| data[oidl + i * 20..oidl + (i + 1) * 20] == want[..])
        .expect("the commit is in the graph");
    let entry = cdat + index * 36;
    data[entry..entry + 20].copy_from_slice(&unhex(tree));
    let body = data.len() - 20;
    let sum = sha1(&data[..body]);
    data[body..].copy_from_slice(&sum);
    // The file is read-only; a new file in its place is how git itself replaces it.
    fs::remove_file(&path).unwrap();
    fs::write(&path, data).unwrap();
}

#[test]
fn sha1_matches_a_known_digest() {
    let digest = sha1(b"abc");
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
}

#[test]
fn r7_n1_a_commit_graph_tree_the_guard_never_read_does_not_reach_the_remote() {
    let (local, remote) = pushed("n1-graph");
    let base = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    // T: a commit whose real tree is the base's tree. T2: an ordinary tip on top of it.
    git(&local.0, &["commit", "-q", "--allow-empty", "-m", "tidy"]);
    let middle = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    fs::write(local.0.join("README.md"), b"hello\nagain\n").unwrap();
    git(&local.0, &["commit", "-q", "-am", "readme"]);
    // A blob with a key and a tree holding it, written into the object store and named by no commit.
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
    let inner = git_in(
        &local.0,
        &["mktree"],
        Some(format!("100644 blob {blob}\tkey.rs\n").as_bytes()),
    )
    .trim()
    .to_string();
    let tree = git_in(
        &local.0,
        &["mktree"],
        Some(format!("100644 blob {readme}\tREADME.md\n040000 tree {inner}\tsrc\n").as_bytes()),
    )
    .trim()
    .to_string();
    // The commit-graph says T's tree is that tree. Every commit object still says what it said.
    git(&local.0, &["commit-graph", "write", "--reachable"]);
    graph_names_tree(&local.0.join(".git"), &middle, &tree);
    assert!(
        git(&local.0, &["diff-tree", "-r", "--raw", &base, &middle])
            .trim()
            .is_empty(),
        "fixture: the raw commit T changes nothing"
    );
    assert!(
        !has_object(&remote.0, &blob),
        "fixture: the remote does not hold the key yet"
    );

    // The app's own push: the guard, then `git push <sha>:refs/heads/main` with the round-7 flags.
    let pushed = crate::fs::git_push_for(&local.0);

    assert!(
        pushed.is_err() || !has_object(&remote.0, &blob),
        "the push sent a blob the guard never read (push result: {pushed:?}); the remote now holds src/key.rs's key"
    );
}

fn git_index(dir: &Path, index: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_INDEX_FILE", index)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// N2 (MEDIUM): the landing patch is `git diff --cached`, and diff reads a path from the working tree instead of the
/// object store when the index entry's stat still matches the file (`reuse_worktree_file`). The check read the staged
/// blob. A worker that rewrites a staged file in place after `git add -A`, with the same size and mtime (and
/// `core.trustctime=false` in its own repo config, or within the same ctime second), lands bytes the check never read.
/// In `land` the rewrite is a race between the add and the patch; the temporary index's name is predictable
/// (`monocode-land-<pid>-<n>.index`), so a watcher can time it. This test runs the same steps in order.
#[test]
fn r7_n2_the_landing_patch_carries_only_the_staged_blob() {
    let root = temp("n2-land");
    let copy = root.0.join("copy");
    fs::create_dir_all(&copy).unwrap();
    git(&copy, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.email", "guard@example.test"),
        ("user.name", "Guard Test"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
        // Worker-writable repo config. The guard's diff still reads it.
        ("core.trustctime", "false"),
    ] {
        git(&copy, &["config", key, value]);
    }
    fs::create_dir_all(copy.join("src")).unwrap();
    fs::write(copy.join("src/config.rs"), b"// empty\n").unwrap();
    git(&copy, &["add", "-A"]);
    git(&copy, &["commit", "-q", "-m", "start"]);
    let base = git(&copy, &["rev-parse", "HEAD"]).trim().to_string();

    let key = fake_key();
    let clean = format!("const KEY: &str = \"{}\";\n", "x".repeat(key.len()));
    let leaked = format!("const KEY: &str = \"{key}\";\n");
    assert_eq!(clean.len(), leaked.len());
    let file = copy.join("src/config.rs");
    fs::write(&file, clean.as_bytes()).unwrap();
    let old = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_577_836_800);
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old).set_accessed(old))
        .unwrap();

    // What land does: a fresh index from HEAD, `git add -A`, the blob check, then the patch.
    let index = root.0.join("land.index");
    git_index(&copy, &index, &["read-tree", "HEAD"]);
    git_index(&copy, &index, &["add", "-A", "--", "."]);
    let files = super::scan_landing_index(&copy, &index, &base, &copy)
        .expect("fixture: the staged blob is clean, so the check passes");
    assert_eq!(files, vec!["src/config.rs".to_string()]);

    // The worker rewrites the file in place: same length, same mtime.
    {
        use std::io::{Seek, SeekFrom, Write};
        let mut handle = fs::File::options().write(true).open(&file).unwrap();
        handle.seek(SeekFrom::Start(0)).unwrap();
        handle.write_all(leaked.as_bytes()).unwrap();
        handle
            .set_times(fs::FileTimes::new().set_modified(old).set_accessed(old))
            .unwrap();
    }
    let staged = git_index(&copy, &index, &["cat-file", "-p", ":src/config.rs"]);
    assert!(
        !staged.contains("sk-ant-"),
        "fixture: the staged blob is clean"
    );

    let patch = super::landing_patch(&copy, &index, &base).expect("the patch is written");
    let text = String::from_utf8_lossy(&patch);
    assert!(
        !text.contains("sk-ant-"),
        "the landing patch carries working-tree bytes the check never read"
    );
}

fn pkt(payload: &str) -> Vec<u8> {
    let mut out = format!("{:04x}", payload.len() + 4).into_bytes();
    out.extend(payload.as_bytes());
    out
}

/// Loopback smart HTTP for `ls-remote`: a request without credentials gets 401 (Basic), one with credentials gets an
/// advertisement of `base` only. Stops when `stop` is set.
#[cfg(unix)]
fn advertise_base(
    listener: std::net::TcpListener,
    base: String,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use std::io::{Read, Write};
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    let _ = listener.set_nonblocking(true);
    let started = std::time::Instant::now();
    while !stop.load(Ordering::Relaxed) && started.elapsed() < Duration::from_secs(30) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|window| window == b"\r\n\r\n") && buf.len() < 65536 {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let headers = String::from_utf8_lossy(&buf).to_ascii_lowercase();
                let response = if !headers.contains("authorization:") {
                    b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"r7\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
                } else {
                    let mut body = Vec::new();
                    body.extend(pkt("# service=git-upload-pack\n"));
                    body.extend(b"0000");
                    body.extend(pkt(&format!("{base} HEAD\0\n")));
                    body.extend(pkt(&format!("{base} refs/heads/main\n")));
                    body.extend(b"0000");
                    let mut head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes();
                    head.extend(body);
                    head
                };
                let _ = stream.write_all(&response);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    }
}

fn in_child() -> bool {
    std::env::var_os("CG_R7_CHILD").is_some()
}

/// N3 (MEDIUM, availability; the open half of round 5's M4): `ls-remote` runs with `GIT_CONFIG_NOSYSTEM=1`. Apple's
/// git (Xcode tools) and Homebrew's git both keep `credential.helper=osxkeychain` in the system config, so on a Mac
/// whose only helper is that one, the guard cannot read a private https remote and refuses every app push, pull
/// request and delivery ("could not read Username"), while `git push` itself would authenticate. Here the stand-in
/// helper sits in a temporary system config (`GIT_CONFIG_SYSTEM`, set only in a child copy of this binary).
#[cfg(unix)]
#[test]
fn r7_n3_the_system_credential_helper_reaches_ls_remote() {
    let home = temp("n3-system-config");
    let system = home.0.join("system.gitconfig");
    let exe = std::env::current_exe().expect("the test binary");
    let module = module_path!();
    let module = module
        .split_once("::")
        .map(|(_, rest)| rest)
        .unwrap_or(module);
    let out = Command::new(exe)
        .args([
            format!("{module}::r7_n3_inner_system_credential_helper").as_str(),
            "--exact",
            "--ignored",
            "--test-threads=1",
            "--nocapture",
        ])
        .env("CG_R7_CHILD", "1")
        .env("GIT_CONFIG_SYSTEM", &system)
        .env_remove("GIT_CONFIG_NOSYSTEM")
        .output()
        .expect("the child test runs");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.status.success() && text.contains("1 passed"),
        "a clean push to a remote that needs the system credential helper was refused:\n{text}"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "run by r7_n3_the_system_credential_helper_reaches_ls_remote in a child"]
fn r7_n3_inner_system_credential_helper() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    if !in_child() {
        return;
    }
    let system =
        PathBuf::from(std::env::var_os("GIT_CONFIG_SYSTEM").expect("set by the outer test"));
    assert!(
        system.to_string_lossy().contains("cg-r7-n3-system-config"),
        "only ever write the outer test's own file: {}",
        system.display()
    );
    let root = temp("n3-repo");
    let helper = root.0.join("helper.sh");
    fs::write(
        &helper,
        "#!/bin/sh\ncat >/dev/null\nprintf 'username=git\\npassword=x\\n\\n'\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        &system,
        format!(
            "[credential]\n\thelper = !'{}'\n[protocol]\n\tversion = 0\n",
            helper.display()
        ),
    )
    .unwrap();

    let local = root.0.join("local");
    fs::create_dir_all(&local).unwrap();
    git(&local, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.email", "guard@example.test"),
        ("user.name", "Guard Test"),
        ("commit.gpgsign", "false"),
    ] {
        git(&local, &["config", key, value]);
    }
    fs::write(local.join("a.txt"), b"one\n").unwrap();
    git(&local, &["add", "-A"]);
    git(&local, &["commit", "-q", "-m", "start"]);
    let base = git(&local, &["rev-parse", "HEAD"]).trim().to_string();
    fs::write(local.join("a.txt"), b"one\ntwo\n").unwrap();
    git(&local, &["commit", "-q", "-am", "clean change"]);

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let url = format!("http://127.0.0.1:{port}/repo.git");
    git(&local, &["remote", "add", "origin", &url]);
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let stop = stop.clone();
        let base = base.clone();
        std::thread::spawn(move || advertise_base(listener, base, stop))
    };

    // Fixture: git itself reads the remote with the system helper.
    let plain = Command::new("git")
        .args(["ls-remote", &url])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    let result = super::gate_outgoing(&local);
    stop.store(true, Ordering::Relaxed);
    let _ = server.join();
    assert!(
        plain.status.success() && String::from_utf8_lossy(&plain.stdout).contains(&base),
        "fixture: plain git ls-remote authenticates with the system helper: {}",
        String::from_utf8_lossy(&plain.stderr)
    );
    assert!(
        result.is_ok(),
        "the guard's ls-remote dropped the system credential helper: {result:?}"
    );
}
