//! WP-200 follow-up: a push uses the URLs the gate already resolved, and a relative push URL is
//! resolved from the work tree, not from the scratch folder `ls-remote` runs in.

use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::*;

fn fake_key() -> String {
    format!("sk-ant-{}", "Ab3dEf7h".repeat(4))
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn has_commit(git_dir: &Path, sha: &str) -> bool {
    Command::new("git")
        .arg("--git-dir")
        .arg(git_dir)
        .args(["cat-file", "-e", &format!("{sha}^{{commit}}")])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `../../name` from the scratch folder (`temp/cg-ls-…/empty`) is `temp/name`. The same string from a
/// work tree nested further down is a different directory. The plant sits where the scratch folder
/// resolves it and already advertises the secret commit. The real remote, where the work tree resolves
/// it, does not.
#[test]
fn a_relative_push_url_is_checked_from_the_work_tree() {
    let id = format!("{}-{}", std::process::id(), uuid::Uuid::new_v4().simple());
    let base = std::env::temp_dir().join(format!("cg-rel-{id}"));
    let work = base.join("a").join("b").join("work");
    let plant_name = format!("cg-plant-{id}.git");
    let real = base.join("a").join(&plant_name);
    let plant = std::env::temp_dir().join(&plant_name);
    let _ = std::fs::remove_dir_all(&base);
    let _ = std::fs::remove_dir_all(&plant);
    std::fs::create_dir_all(&work).unwrap();
    git(
        &std::env::temp_dir(),
        &["init", "-q", "--bare", real.to_str().unwrap()],
    );
    git(
        &std::env::temp_dir(),
        &["init", "-q", "--bare", plant.to_str().unwrap()],
    );
    git(&work, &["init", "-q", "-b", "main"]);
    git(&work, &["config", "user.email", "guard@example.test"]);
    git(&work, &["config", "user.name", "Guard Test"]);
    git(&work, &["config", "commit.gpgsign", "false"]);
    let key = fake_key();
    std::fs::write(
        work.join("src.txt"),
        format!("const KEY: &str = \"{key}\";\n"),
    )
    .unwrap();
    git(&work, &["add", "src.txt"]);
    git(&work, &["commit", "-qm", "secret"]);
    git(&work, &["remote", "add", "origin", plant.to_str().unwrap()]);
    git(&work, &["push", "origin", "main"]);
    let relative = format!("../../{plant_name}");
    git(&work, &["remote", "set-url", "origin", &relative]);
    let from_work = lexical(&work.join(&relative));
    let from_scratch = lexical(
        &std::env::temp_dir()
            .join("cg-ls-depth")
            .join("empty")
            .join(&relative),
    );
    assert_ne!(
        from_work, from_scratch,
        "the fixture resolves both ways to one directory"
    );
    assert_ne!(
        std::fs::canonicalize(&real).unwrap(),
        std::fs::canonicalize(&plant).unwrap(),
        "the plant and the work-tree remote are the same directory"
    );
    let err =
        gate_outgoing(&work).expect_err("a relative url must not be read from the scratch folder");
    assert!(
        err.starts_with("Possible secret"),
        "the refusal is not the secret check: {err}"
    );
    let _ = std::fs::remove_dir_all(&base);
    let _ = std::fs::remove_dir_all(&plant);
}

/// Speaks git protocol for `decoy`. The first connection is the gate's `ls-remote`: before it
/// answers, this points `remote.origin.pushurl` at `victim`. A later `git push origin` follows that
/// new pushurl. The push must keep the URL the gate already read.
struct GitFlip {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl GitFlip {
    fn start(decoy: PathBuf, local_git: PathBuf, victim: PathBuf) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            let flipped = AtomicBool::new(false);
            for stream in listener.incoming() {
                if stop_for_thread.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { break };
                serve_decoy(&stream, &decoy, &local_git, &victim, &flipped);
            }
        });
        Self {
            port,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for GitFlip {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn read_pkt(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut len_bytes = [0u8; 4];
    stream.read_exact(&mut len_bytes).ok()?;
    let len = usize::from_str_radix(std::str::from_utf8(&len_bytes).ok()?, 16).ok()?;
    if len < 4 {
        return None;
    }
    let mut body = vec![0u8; len - 4];
    stream.read_exact(&mut body).ok()?;
    Some(body)
}

fn pump(from: &mut impl Read, to: &mut impl std::io::Write) {
    let mut buf = [0u8; 8192];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if to.write_all(&buf[..n]).and_then(|()| to.flush()).is_err() {
                    return;
                }
            }
        }
    }
}

fn serve_decoy(
    stream: &TcpStream,
    decoy: &Path,
    local_git: &Path,
    victim: &Path,
    flipped: &AtomicBool,
) {
    let mut stream = stream.try_clone().unwrap();
    let _ = stream.set_nodelay(true);
    let Some(body) = read_pkt(&mut stream) else {
        return;
    };
    let text = String::from_utf8_lossy(&body);
    let service = if text.contains("git-receive-pack") {
        "receive-pack"
    } else if text.contains("git-upload-pack") {
        "upload-pack"
    } else {
        return;
    };
    if !flipped.swap(true, Ordering::SeqCst) {
        let set = Command::new("git")
            .arg("--git-dir")
            .arg(local_git)
            .args(["config", "remote.origin.pushurl", &victim.to_string_lossy()])
            .status();
        assert!(
            set.unwrap().success(),
            "the fixture could not rewrite pushurl"
        );
    }
    let protocol = text
        .split('\0')
        .find(|part| part.starts_with("version="))
        .unwrap_or("")
        .to_string();
    let mut cmd = Command::new("git");
    cmd.arg(service).arg(decoy);
    if !protocol.is_empty() {
        cmd.env("GIT_PROTOCOL", &protocol);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut child_in = child.stdin.take().unwrap();
    let mut child_out = child.stdout.take().unwrap();
    let mut from_client = stream.try_clone().unwrap();
    // A plain read and write loop, not `io::copy`: on Linux `io::copy` between a socket and a pipe uses
    // splice(2), which was seen holding the client's ls-refs request until the check timed out.
    let to_child = std::thread::spawn(move || pump(&mut from_client, &mut child_in));
    let to_client = std::thread::spawn(move || pump(&mut child_out, &mut stream));
    let _ = child.wait();
    let _ = to_child.join();
    let _ = to_client.join();
}

struct FlipRepo {
    root: PathBuf,
    local: PathBuf,
    decoy: PathBuf,
    victim: PathBuf,
    sha: String,
    _server: GitFlip,
}

impl Drop for FlipRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn flip_repo(tag: &str) -> FlipRepo {
    let id = format!(
        "{tag}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    );
    let root = std::env::temp_dir().join(format!("cg-flip-{id}"));
    let local = root.join("local");
    let decoy = root.join("decoy.git");
    let victim = root.join("victim.git");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&local).unwrap();
    git(&local, &["init", "-q", "-b", "main"]);
    git(&local, &["config", "user.email", "guard@example.test"]);
    git(&local, &["config", "user.name", "Guard Test"]);
    git(&local, &["config", "commit.gpgsign", "false"]);
    std::fs::write(local.join("ok.txt"), "ok\n").unwrap();
    git(&local, &["add", "ok.txt"]);
    git(&local, &["commit", "-qm", "base"]);
    git(
        &std::env::temp_dir(),
        &[
            "clone",
            "-q",
            "--bare",
            local.to_str().unwrap(),
            decoy.to_str().unwrap(),
        ],
    );
    git(
        &std::env::temp_dir(),
        &[
            "clone",
            "-q",
            "--bare",
            local.to_str().unwrap(),
            victim.to_str().unwrap(),
        ],
    );
    let key = fake_key();
    std::fs::write(
        local.join("secret.txt"),
        format!("const KEY: &str = \"{key}\";\n"),
    )
    .unwrap();
    git(&local, &["add", "secret.txt"]);
    git(&local, &["commit", "-qm", "secret"]);
    let sha = {
        let out = Command::new("git")
            .arg("-C")
            .arg(&local)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(out.status.success());
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    git(
        &local,
        &["remote", "add", "origin", decoy.to_str().unwrap()],
    );
    git(&local, &["push", "origin", "main"]);
    assert!(
        has_commit(&decoy, &sha),
        "the decoy did not take the commit"
    );
    assert!(
        !has_commit(&victim, &sha),
        "the victim already has the commit"
    );
    let server = GitFlip::start(decoy.clone(), local.join(".git"), victim.clone());
    let url = format!("git://127.0.0.1:{}/decoy", server.port);
    git(&local, &["remote", "set-url", "--push", "origin", &url]);
    FlipRepo {
        root,
        local,
        decoy,
        victim,
        sha,
        _server: server,
    }
}

fn assert_push_stayed(result: Result<(), String>, repo: &FlipRepo) {
    if let Err(error) = result {
        panic!("the push of the checked url failed: {error}");
    }
    assert!(
        !has_commit(&repo.victim, &repo.sha),
        "the push followed a pushurl written after the check"
    );
    assert!(
        has_commit(&repo.decoy, &repo.sha),
        "the checked destination lost the commit"
    );
}

#[test]
fn flipping_pushurl_between_the_check_and_git_push_for_cannot_move_the_push() {
    let repo = flip_repo("fs");
    let result = crate::fs::git_push_for(&repo.local);
    assert_push_stayed(result, &repo);
}

#[test]
fn flipping_pushurl_between_the_check_and_push_sha_cannot_move_the_push() {
    let repo = flip_repo("deliver");
    let result = crate::delivery::deliver::push_sha(&repo.local, "origin", "main", &repo.sha);
    assert_push_stayed(result, &repo);
}
