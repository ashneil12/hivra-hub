//! Round 6 checks that are not in the reviewer's round-5 file. That file stays verbatim.

use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
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
        fs::write(
            &path,
            "#!/bin/sh\nif [ -n \"$HELPER_MARKER\" ]; then printf '%s\\n' \"$1\" >> \"$HELPER_MARKER\"; fi\ncat >/dev/null\nexit 0\n",
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
            "@echo off\r\nif defined HELPER_MARKER echo %1>> \"%HELPER_MARKER%\"\r\nexit /b 0\r\n",
        )
        .unwrap();
        path
    }
}

/// The one `ls-remote` keeps the process global config. A temporary global file rewrites a public name onto a local
/// bare repository and names a stand-in credential helper. The refusal has to name the secret file: a connection
/// error would also be `Err`, and would not show that the global file was read. A real private remote is not used.
#[test]
fn ls_remote_reads_a_temporary_global_config_and_its_credential_helper() {
    static LOCK: Mutex<()> = Mutex::new(());
    let _lock = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = temp("global");
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
    write(
        &local,
        "src/config.rs",
        format!("const KEY: &str = \"{}\";\n", fake_key()).as_bytes(),
    );
    git(&local, &["add", "src/config.rs"]);
    git(&local, &["commit", "-qm", "config"]);
    git(
        &local,
        &[
            "config",
            "remote.origin.url",
            "https://hivra-m4.invalid/repo.git",
        ],
    );

    let global = root.0.join("global.gitconfig");
    let marker = root.0.join("helper.log");
    let helper = write_helper(&root.0);
    git_file(&[
        "config",
        "--file",
        global.to_str().unwrap(),
        "credential.helper",
        &format!("!'{}'", slashes(&helper)),
    ]);
    git_file(&[
        "config",
        "--file",
        global.to_str().unwrap(),
        &format!("url.{}.insteadOf", slashes(&bare)),
        "https://hivra-m4.invalid/repo.git",
    ]);

    let result = {
        let _env = RestoreEnv::apply(&global, &marker);
        gate_outgoing(&local)
    };
    let err = result.expect_err("the global rewrite must not count as a failed remote");
    assert!(
        err.starts_with("Possible secret in src/config.rs:"),
        "global config was not used for ls-remote: {err}"
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
