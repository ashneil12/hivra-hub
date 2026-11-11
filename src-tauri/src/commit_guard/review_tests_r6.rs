//! Round 6 checks that are not in the reviewer's round-5 file. That file stays verbatim.

use super::*;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    let path = std::env::temp_dir().join(format!("cg-r6-{tag}-{}-{nanos}", std::process::id()));
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

fn git_file(args: &[&str]) -> String {
    let out = Command::new("git").args(args).output().expect("git runs");
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

fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Puts the previous process environment back, including when the check panics.
struct RestoreEnv {
    global: Option<std::ffi::OsString>,
    marker: Option<std::ffi::OsString>,
}

impl RestoreEnv {
    fn apply(global: &Path, marker: &Path) -> Self {
        let previous = Self {
            global: std::env::var_os("GIT_CONFIG_GLOBAL"),
            marker: std::env::var_os("HELPER_MARKER"),
        };
        std::env::set_var("GIT_CONFIG_GLOBAL", global);
        std::env::set_var("HELPER_MARKER", marker);
        previous
    }
}

impl Drop for RestoreEnv {
    fn drop(&mut self) {
        restore("GIT_CONFIG_GLOBAL", self.global.take());
        restore("HELPER_MARKER", self.marker.take());
    }
}

fn restore(name: &str, value: Option<std::ffi::OsString>) {
    match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
}

fn write_helper(dir: &Path) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("helper.sh");
        // Read the prompt first, then answer, so git's pipe does not stall. `$1` is the action (`get`).
        fs::write(
            &path,
            "#!/bin/sh\ncat >/dev/null\nif [ -n \"$HELPER_MARKER\" ]; then printf '%s\\n' \"$1\" >> \"$HELPER_MARKER\"; fi\nprintf 'username=git\\npassword=x\\n\\n'\nexit 0\n",
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }
    #[cfg(windows)]
    {
        let path = dir.join("helper.cmd");
        fs::write(
            &path,
            "@echo off\r\nif defined HELPER_MARKER echo %1>> \"%HELPER_MARKER%\"\r\necho username=git\r\necho password=x\r\necho.\r\nexit /b 0\r\n",
        )
        .unwrap();
        path
    }
}

fn pkt(payload: &str) -> Vec<u8> {
    let mut out = format!("{:04x}", payload.len() + 4).into_bytes();
    out.extend(payload.as_bytes());
    out
}

fn read_http_headers(stream: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|window| window == b"\r\n\r\n") && buf.len() < 65536 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Speaks just enough smart HTTP for `ls-remote`: the first request is refused with Basic auth, and the next one
/// advertises only `base`. Loopback only. Stops when `stop` is set, so the test does not leave a thread waiting.
fn advertise_base(listener: TcpListener, base: String, stop: Arc<AtomicBool>) {
    let _ = listener.set_nonblocking(true);
    let started = std::time::Instant::now();
    while !stop.load(Ordering::Relaxed) && started.elapsed() < Duration::from_secs(30) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let headers = read_http_headers(&mut stream);
                let authed = headers.to_ascii_lowercase().contains("authorization:");
                let response = if !authed {
                    b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"hivra\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
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

/// The push URL is resolved with the process global config, and `ls-remote` keeps that file's credential helper
/// while dropping `url.*`. A loopback smart-HTTP remote asks for Basic auth, so the stand-in helper has to run and
/// write its marker. The advertisement names only the base commit. A decoy bare holds the secret commit: if
/// `ls-remote` still applied `url.*`, it would read the decoy and the gate would allow the push. The real
/// `~/.gitconfig` is never written. The refusal has to name the secret file.
#[test]
fn ls_remote_reads_a_temporary_global_config_and_its_credential_helper() {
    static LOCK: Mutex<()> = Mutex::new(());
    let _lock = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = temp("global");
    let bare = root.0.join("remote.git");
    let decoy = root.0.join("decoy.git");
    let local = root.0.join("local");
    fs::create_dir_all(&bare).unwrap();
    fs::create_dir_all(&decoy).unwrap();
    git(
        &root.0,
        &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()],
    );
    git(
        &root.0,
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            decoy.to_str().unwrap(),
        ],
    );
    git(
        &root.0,
        &["init", "-q", "-b", "main", local.to_str().unwrap()],
    );
    configure(&local);
    write(&local, "a.txt", b"one\n");
    git(&local, &["add", "a.txt"]);
    git(&local, &["commit", "-qm", "start"]);
    let base = git(&local, &["rev-parse", "HEAD"]).trim().to_string();
    git(&local, &["remote", "add", "origin", &slashes(&bare)]);
    git(&local, &["push", "-q", "origin", "main"]);
    write(
        &local,
        "src/config.rs",
        format!("const KEY: &str = \"{}\";\n", fake_key()).as_bytes(),
    );
    git(&local, &["add", "src/config.rs"]);
    git(&local, &["commit", "-qm", "config"]);
    git(&local, &["push", "-q", &slashes(&decoy), "main"]);
    git(&local, &["config", "remote.origin.url", "hivra-alias:"]);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let http = format!("http://127.0.0.1:{port}/repo.git");
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let stop = stop.clone();
        let base = base.clone();
        std::thread::spawn(move || advertise_base(listener, base, stop))
    };

    let global = root.0.join("global.gitconfig");
    let marker = root.0.join("helper.log");
    let helper = write_helper(&root.0);
    let file = global.to_str().unwrap();
    git_file(&[
        "config",
        "--file",
        file,
        "credential.helper",
        &format!("!'{}'", slashes(&helper)),
    ]);
    git_file(&["config", "--file", file, "protocol.version", "0"]);
    git_file(&[
        "config",
        "--file",
        file,
        &format!("url.{http}.pushInsteadOf"),
        "hivra-alias:",
    ]);
    git_file(&[
        "config",
        "--file",
        file,
        &format!("url.{}.insteadOf", slashes(&decoy)),
        &http,
    ]);

    let result = {
        let _env = RestoreEnv::apply(&global, &marker);
        gate_outgoing(&local)
    };
    stop.store(true, Ordering::Relaxed);
    let _ = server.join();
    let err = result.expect_err("the global rewrite must not count as a failed remote");
    assert!(
        err.starts_with("Possible secret in src/config.rs:"),
        "global config was not used for ls-remote: {err}"
    );
    let ran = fs::read_to_string(&marker).unwrap_or_default();
    assert!(
        ran.lines().any(|line| line == "get"),
        "the credential helper never ran: {ran:?}"
    );
}

/// A secret only in an inner annotated tag, under a clean outer tag, is still a finding.
#[test]
fn an_inner_annotated_tag_message_is_scanned() {
    let root = temp("tagchain");
    let bare = root.0.join("remote.git");
    let local = root.0.join("local");
    fs::create_dir_all(&bare).unwrap();
    git(
        &root.0,
        &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()],
    );
    git(
        &root.0,
        &["init", "-q", "-b", "main", local.to_str().unwrap()],
    );
    configure(&local);
    write(&local, "a.txt", b"one\n");
    git(&local, &["add", "a.txt"]);
    git(&local, &["commit", "-qm", "start"]);
    git(&local, &["remote", "add", "origin", &slashes(&bare)]);
    git(&local, &["push", "-q", "origin", "main"]);
    git(
        &local,
        &[
            "tag",
            "-a",
            "inner",
            "-m",
            &format!("release {}", fake_key()),
        ],
    );
    git(&local, &["tag", "-a", "outer", "-m", "ship it", "inner"]);
    let sha = git(&local, &["rev-parse", "refs/tags/outer"]);
    let sha = sha.trim();
    let stdin = format!("refs/tags/outer {sha} refs/tags/outer {}\n", "0".repeat(40));
    let err = pre_push_stdin_check(&local, "origin", &stdin)
        .expect_err("an inner tag message holding a secret was not checked");
    assert!(
        err.starts_with("Possible secret in a commit message:"),
        "{err}"
    );
}
