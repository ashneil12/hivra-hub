//! Review of PR #227 (WP-200), round 8. The r7 repros stay as they are. These tests cover the hook
//! path the app push flags do not, a system credential helper with no global helper, and upstream
//! after a refspec push.

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
    let path = std::env::temp_dir().join(format!("cg-r8-{tag}-{}-{nanos}", std::process::id()));
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
    fs::remove_file(&path).unwrap();
    fs::write(&path, data).unwrap();
}

/// The pre-push hook cannot pass `-c` to the parent `git push`. A lying commit-graph must still
/// be refused here, not only on the app's own push.
#[test]
fn r8_n1_the_pre_push_check_refuses_a_commit_graph_blob_it_did_not_read() {
    let (local, _remote) = pushed("n1-hook");
    let base = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    git(&local.0, &["commit", "-q", "--allow-empty", "-m", "tidy"]);
    let middle = git(&local.0, &["rev-parse", "HEAD"]).trim().to_string();
    fs::write(local.0.join("README.md"), b"hello\nagain\n").unwrap();
    git(&local.0, &["commit", "-q", "-am", "readme"]);
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
    git(&local.0, &["commit-graph", "write", "--reachable"]);
    graph_names_tree(&local.0.join(".git"), &middle, &tree);
    assert!(
        git(&local.0, &["diff-tree", "-r", "--raw", &base, &middle])
            .trim()
            .is_empty(),
        "fixture: the raw commit changes nothing"
    );

    let stdin = format!("refs/heads/main {tip} refs/heads/main {base}\n");
    let checked = super::pre_push_stdin_check(&local.0, "origin", &stdin);
    let message = checked.as_ref().err().map(String::as_str).unwrap_or("");
    assert!(
        checked.is_err()
            && (message.contains("Possible secret") || message.contains("commit graph")),
        "the hook path sent a blob the guard never read: {checked:?}"
    );
}

/// `git push <sha>:refs/heads/<branch> -u` does not set the upstream. Sync would stop pulling.
#[test]
fn r8_a_refspec_push_sets_the_upstream() {
    let remote = temp("upstream-remote");
    git(&remote.0, &["init", "-q", "--bare", "-b", "main"]);
    let local = temp("upstream");
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
    fs::write(local.0.join("README.md"), b"hello\n").unwrap();
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "base"]);
    git(&local.0, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    let before = Command::new("git")
        .arg("-C")
        .arg(&local.0)
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .output()
        .unwrap();
    assert!(
        !before.status.success(),
        "fixture: the refspec push already set an upstream"
    );
    fs::write(local.0.join("README.md"), b"hello\nagain\n").unwrap();
    git(&local.0, &["commit", "-q", "-am", "readme"]);

    crate::fs::git_push_for(&local.0).expect("a clean push");
    assert_eq!(
        git(&local.0, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(),
        "origin/main"
    );
}

/// The push lands. The remote's fetch refspec maps only `main`, so `topic` cannot be recorded as the upstream.
#[test]
fn r8_a_push_lands_when_the_fetch_refspec_cannot_record_the_upstream() {
    let remote = temp("nomap-remote");
    git(&remote.0, &["init", "-q", "--bare", "-b", "main"]);
    let local = temp("nomap");
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
    git(
        &local.0,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/main:refs/remotes/origin/main",
        ],
    );
    fs::write(local.0.join("README.md"), b"hello\n").unwrap();
    git(&local.0, &["add", "-A"]);
    git(&local.0, &["commit", "-q", "-m", "base"]);
    git(&local.0, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    git(&local.0, &["checkout", "-q", "-b", "topic"]);
    fs::write(local.0.join("README.md"), b"topic\n").unwrap();
    git(&local.0, &["commit", "-q", "-am", "topic"]);

    crate::fs::git_push_for(&local.0).expect("the push landed");
    let remote_tip = Command::new("git")
        .arg("-C")
        .arg(&remote.0)
        .args(["rev-parse", "--verify", "refs/heads/topic"])
        .output()
        .unwrap();
    assert!(
        remote_tip.status.success(),
        "the remote did not receive the branch: {}",
        String::from_utf8_lossy(&remote_tip.stderr)
    );
    let upstream = Command::new("git")
        .arg("-C")
        .arg(&local.0)
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .output()
        .unwrap();
    assert!(
        !upstream.status.success(),
        "a fetch refspec that does not map the branch still recorded an upstream"
    );
}

/// A commit-graph git itself accepts is not a reason to refuse a clean push.
#[test]
fn r8_a_valid_commit_graph_does_not_refuse_a_clean_push() {
    let (local, _remote) = pushed("valid-graph");
    git(&local.0, &["commit-graph", "write", "--reachable"]);
    fs::write(local.0.join("README.md"), b"hello\nmore\n").unwrap();
    git(&local.0, &["commit", "-q", "-am", "more"]);
    let tip = git(&local.0, &["rev-parse", "HEAD"]);
    let base = git(&local.0, &["rev-parse", "HEAD~1"]);
    let stdin = format!(
        "refs/heads/main {} refs/heads/main {}\n",
        tip.trim(),
        base.trim()
    );
    super::pre_push_stdin_check(&local.0, "origin", &stdin)
        .expect("a valid commit-graph still allows a clean push");
}

/// `git commit-graph verify` does not read a graph in an alternate object store, and a push still would.
#[test]
fn r8_an_alternate_object_store_with_a_commit_graph_is_not_trusted() {
    let (local, _remote) = pushed("alt-graph");
    let other = temp("alt-store");
    git(&other.0, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.email", "guard@example.test"),
        ("user.name", "Guard Test"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(&other.0, &["config", key, value]);
    }
    fs::write(other.0.join("README.md"), b"hello\n").unwrap();
    git(&other.0, &["add", "-A"]);
    git(&other.0, &["commit", "-q", "-m", "other"]);
    git(&other.0, &["commit-graph", "write", "--reachable"]);
    let git_dir = git(&other.0, &["rev-parse", "--absolute-git-dir"]);
    let objects = PathBuf::from(git_dir.trim()).join("objects");
    let info = local.0.join(".git").join("objects").join("info");
    fs::create_dir_all(&info).unwrap();
    fs::write(
        info.join("alternates"),
        format!("# note\n\n{}\n", objects.display()),
    )
    .unwrap();
    fs::write(local.0.join("README.md"), b"hello\nclean\n").unwrap();
    git(&local.0, &["commit", "-q", "-am", "clean"]);
    let tip = git(&local.0, &["rev-parse", "HEAD"]);
    let base = git(&local.0, &["rev-parse", "HEAD~1"]);
    let stdin = format!(
        "refs/heads/main {} refs/heads/main {}\n",
        tip.trim(),
        base.trim()
    );
    let checked = super::pre_push_stdin_check(&local.0, "origin", &stdin);
    let message = checked.as_ref().err().map(String::as_str).unwrap_or("");
    assert!(
        checked.is_err() && message.contains("commit graph"),
        "an alternate commit-graph was trusted: {checked:?}"
    );
}

#[cfg(unix)]
fn pkt(payload: &str) -> Vec<u8> {
    let mut out = format!("{:04x}", payload.len() + 4).into_bytes();
    out.extend(payload.as_bytes());
    out
}

/// Loopback smart HTTP. No credentials: 401. With credentials: a v0 advertisement, or a v2
/// ls-refs answer when the client asks for protocol v2. The guard must not need `protocol.version`
/// copied out of the system file.
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
    while !stop.load(Ordering::Relaxed) && started.elapsed() < Duration::from_secs(40) {
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
                let head = String::from_utf8_lossy(&buf);
                let headers = head.to_ascii_lowercase();
                if let Some(length) = headers
                    .split("content-length:")
                    .nth(1)
                    .and_then(|rest| rest.split(['\r', '\n']).next())
                    .and_then(|text| text.trim().parse::<usize>().ok())
                {
                    while buf.len() < headers.find("\r\n\r\n").unwrap_or(0) + 4 + length
                        && buf.len() < 65536
                    {
                        match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                }
                let request = String::from_utf8_lossy(&buf).to_ascii_lowercase();
                let response = if !request.contains("authorization:") {
                    b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"r8\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
                } else {
                    let v2 = request.contains("git-protocol:") && request.contains("version=2");
                    let post = request.starts_with("post ");
                    let mut body = Vec::new();
                    if v2 && post {
                        body.extend(pkt(&format!("{base} HEAD\n")));
                        body.extend(pkt(&format!("{base} refs/heads/main\n")));
                        body.extend(b"0000");
                    } else if v2 {
                        body.extend(pkt("# service=git-upload-pack\n"));
                        body.extend(b"0000");
                        body.extend(pkt("version 2\n"));
                        body.extend(pkt("ls-refs\n"));
                        body.extend(pkt("fetch=shallow\n"));
                        body.extend(pkt("object-format=sha1\n"));
                        body.extend(b"0000");
                    } else {
                        body.extend(pkt("# service=git-upload-pack\n"));
                        body.extend(b"0000");
                        body.extend(pkt(&format!("{base} HEAD\0\n")));
                        body.extend(pkt(&format!("{base} refs/heads/main\n")));
                        body.extend(b"0000");
                    }
                    let kind = if v2 && post {
                        "application/x-git-upload-pack-result"
                    } else {
                        "application/x-git-upload-pack-advertisement"
                    };
                    let mut head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
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

#[cfg(unix)]
fn in_child() -> bool {
    std::env::var_os("CG_R8_CHILD").is_some()
}

/// No global helper, a system helper, and a `url.insteadOf` that must not be copied. `gh`'s
/// `hosts.yml` has to stay visible. A second half keeps auth that lives behind `includeIf`.
/// Split in the round 9 review: the guard now resolves the push URL with the system file `git push`
/// reads, so the second half's system `url.insteadOf` refuses the push
/// (`r8_n3_limit_a_system_url_rewrite_refuses_the_push`). The second half here keeps the includeIf
/// check with the system file emptied instead.
#[cfg(unix)]
#[test]
fn r8_n3_system_credential_helper_reaches_ls_remote_without_a_global_helper() {
    let home = temp("n3-home");
    let system = home.0.join("system.gitconfig");
    let global = home.0.join("global.gitconfig");
    fs::write(&global, "").unwrap();
    let xdg = home.0.join("xdg");
    fs::create_dir_all(xdg.join("gh")).unwrap();
    let exe = std::env::current_exe().expect("the test binary");
    // The lib harness lists this module without the `commit_guard::` prefix (same as the r7 child).
    let module = module_path!();
    let module = module
        .split_once("::")
        .map(|(_, rest)| rest)
        .unwrap_or(module);
    let filter = format!("{module}::r8_n3_inner_system_credential_helper");
    let out = Command::new(exe)
        .args([
            filter.as_str(),
            "--exact",
            "--ignored",
            "--test-threads=1",
            "--nocapture",
        ])
        .env("CG_R8_CHILD", "1")
        .env("HOME", &home.0)
        .env("GIT_CONFIG_GLOBAL", &global)
        .env("GIT_CONFIG_SYSTEM", &system)
        .env("XDG_CONFIG_HOME", &xdg)
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
        "ls-remote did not keep the system credential helper:\n{text}"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "run by r8_n3_system_credential_helper_reaches_ls_remote_without_a_global_helper in a child"]
fn r8_n3_inner_system_credential_helper() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    if !in_child() {
        return;
    }
    let system =
        PathBuf::from(std::env::var_os("GIT_CONFIG_SYSTEM").expect("set by the outer test"));
    let global =
        PathBuf::from(std::env::var_os("GIT_CONFIG_GLOBAL").expect("set by the outer test"));
    let xdg = PathBuf::from(std::env::var_os("XDG_CONFIG_HOME").expect("set by the outer test"));
    for path in [&system, &global, &xdg] {
        assert!(
            path.to_string_lossy().contains("cg-r8-n3-home"),
            "only ever write the outer test's own file: {}",
            path.display()
        );
    }
    fs::write(xdg.join("gh").join("hosts.yml"), "github.com:\n").unwrap();
    let root = temp("n3-repo");
    let marker = root.0.join("marker.txt");
    let helper = root.0.join("helper.sh");
    fs::write(
        &helper,
        format!(
            "#!/bin/sh\ncat >/dev/null\nif [ ! -f \"$XDG_CONFIG_HOME/gh/hosts.yml\" ]; then printf 'missing\\n' >> '{}'; exit 1; fi\nprintf 'system\\n' >> '{}'\nprintf 'username=git\\npassword=x\\n\\n'\nexit 0\n",
            marker.display(),
            marker.display()
        ),
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

    let result = super::gate_outgoing(&local);
    let marked = fs::read_to_string(&marker).unwrap_or_default();
    assert!(
        result.is_ok() && marked.contains("system"),
        "the system helper did not authenticate ls-remote (marker {marked:?}): {result:?}"
    );

    // Round 9 review split: no system url rewrite here (see the limit test). The system helper is gone too.
    fs::write(&system, "").unwrap();
    let included = root.0.join("included.gitconfig");
    let helper_b = root.0.join("helper-b.sh");
    fs::write(
        &helper_b,
        format!(
            "#!/bin/sh\ncat >/dev/null\nprintf 'included\\n' >> '{}'\nprintf 'username=git\\npassword=x\\n\\n'\nexit 0\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&helper_b, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        &included,
        format!("[credential]\n\thelper = !'{}'\n", helper_b.display()),
    )
    .unwrap();
    fs::write(
        &global,
        format!(
            "[includeIf \"gitdir:**\"]\n\tpath = {}\n",
            included.display()
        ),
    )
    .unwrap();
    fs::write(&marker, "").unwrap();
    let included_result = super::gate_outgoing(&local);
    stop.store(true, Ordering::Relaxed);
    let _ = server.join();
    let marked = fs::read_to_string(&marker).unwrap_or_default();
    assert!(
        included_result.is_ok() && marked.contains("included") && !marked.contains("system"),
        "includeIf auth was dropped or the system url rewrite was applied (marker {marked:?}): {included_result:?}"
    );
}

/// Split from r8_n3 in the round 9 review. A system `url.insteadOf` sends `git push origin` to a
/// decoy, and the guard resolves the push URL with that same system file, so it asks the decoy and
/// the push is refused. It must not ask, or authenticate to, the real server the push never reaches.
#[cfg(unix)]
#[test]
fn r8_n3_limit_a_system_url_rewrite_refuses_the_push() {
    let home = temp("n3-limit-home");
    let system = home.0.join("system.gitconfig");
    let global = home.0.join("global.gitconfig");
    fs::write(&global, "").unwrap();
    let exe = std::env::current_exe().expect("the test binary");
    let module = module_path!();
    let module = module
        .split_once("::")
        .map(|(_, rest)| rest)
        .unwrap_or(module);
    let filter = format!("{module}::r8_n3_limit_inner_system_url_rewrite");
    let out = Command::new(exe)
        .args([
            filter.as_str(),
            "--exact",
            "--ignored",
            "--test-threads=1",
            "--nocapture",
        ])
        .env("CG_R8_CHILD", "1")
        .env("HOME", &home.0)
        .env("GIT_CONFIG_GLOBAL", &global)
        .env("GIT_CONFIG_SYSTEM", &system)
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
        "a system url rewrite did not refuse the push:\n{text}"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "run by r8_n3_limit_a_system_url_rewrite_refuses_the_push in a child"]
fn r8_n3_limit_inner_system_url_rewrite() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    if !in_child() {
        return;
    }
    let system =
        PathBuf::from(std::env::var_os("GIT_CONFIG_SYSTEM").expect("set by the outer test"));
    let global =
        PathBuf::from(std::env::var_os("GIT_CONFIG_GLOBAL").expect("set by the outer test"));
    for path in [&system, &global] {
        assert!(
            path.to_string_lossy().contains("cg-r8-n3-limit-home"),
            "only ever write the outer test's own file: {}",
            path.display()
        );
    }
    let root = temp("n3-limit-repo");
    let marker = root.0.join("marker.txt");
    let helper = root.0.join("helper.sh");
    fs::write(
        &helper,
        format!(
            "#!/bin/sh\ncat >/dev/null\nprintf 'included\\n' >> '{}'\nprintf 'username=git\\npassword=x\\n\\n'\nexit 0\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
    let included = root.0.join("included.gitconfig");
    fs::write(
        &included,
        format!("[credential]\n\thelper = !'{}'\n", helper.display()),
    )
    .unwrap();
    fs::write(
        &global,
        format!(
            "[includeIf \"gitdir:**\"]\n\tpath = {}\n",
            included.display()
        ),
    )
    .unwrap();
    fs::write(
        &system,
        "[url \"http://127.0.0.1:1/decoy/\"]\n\tinsteadOf = http://127.0.0.1:\n",
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
    let pushes_to = git(&local, &["remote", "get-url", "--push", "origin"]);
    assert!(
        pushes_to.contains("127.0.0.1:1/decoy/"),
        "fixture: `git push origin` goes to the decoy: {pushes_to}"
    );
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let stop = stop.clone();
        std::thread::spawn(move || advertise_base(listener, base, stop))
    };

    let result = super::gate_outgoing(&local);
    stop.store(true, Ordering::Relaxed);
    let _ = server.join();
    let marked = fs::read_to_string(&marker).unwrap_or_default();
    assert!(
        result.is_err() && !marked.contains("included"),
        "the guard asked the server the push never reaches, or passed the push (marker {marked:?}): {result:?}"
    );
}
