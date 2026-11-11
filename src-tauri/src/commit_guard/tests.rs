use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// A key shaped like an Anthropic key, built here so no source file holds a real secret.
fn fake_key() -> String {
    format!("sk-ant-{}", "Ab3dEf7h".repeat(4))
}

/// The key's value without its shape prefix: a leak check looks for this in any error text.
fn key_body(key: &str) -> &str {
    &key[7..]
}

struct Repo(PathBuf);

impl Repo {
    fn dir(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("commit-guard-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn new(tag: &str) -> Self {
        let repo = Self::dir(tag);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "guard@example.test"]);
        repo.git(&["config", "user.name", "Guard Test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }

    fn bare(tag: &str) -> Self {
        let repo = Self::dir(tag);
        repo.git(&["init", "-q", "--bare", "-b", "main"]);
        repo
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.0)
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

    fn write(&self, rel: &str, text: &str) {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn commit(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
    }

    fn staged(&self) -> Vec<String> {
        self.git(&["diff", "--cached", "--name-only"])
            .lines()
            .map(str::to_string)
            .collect()
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A repo whose `origin` already holds one commit, so `HEAD --not --remotes` starts empty.
fn pushed_repo(tag: &str) -> (Repo, Repo) {
    let remote = Repo::bare(&format!("{tag}-remote"));
    let local = Repo::new(tag);
    local.git(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
    local.write("README.md", "hello\n");
    local.commit("base");
    local.git(&["push", "-q", "-u", "origin", "main"]);
    (local, remote)
}

/// A unified diff (-U0) adding `lines` to `file` starting at line `start`.
fn patch_lines(file: &str, start: usize, lines: &[&str]) -> String {
    let mut out = format!(
        "diff --git a/{file} b/{file}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +{start},{} @@\n",
        lines.len()
    );
    for line in lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[test]
fn an_untracked_agent_file_and_transcript_are_left_out_of_staging() {
    let repo = Repo::new("stage");
    repo.write("README.md", "hello\n");
    repo.commit("base");
    repo.write(
        ".claude/settings.local.json",
        "{\"permissions\":{\"allow\":[\"Bash(make)\"]}}\n",
    );
    repo.write(".claude/projects/app/session.jsonl", "{\"turn\":1}\n");
    repo.write("src/app.txt", "shipped\n");
    stage_all(repo.path()).expect("staging runs");
    assert_eq!(repo.staged(), vec!["src/app.txt".to_string()]);
}

#[test]
fn a_tracked_copy_of_the_same_path_is_staged_normally() {
    let repo = Repo::new("tracked");
    repo.write("README.md", "hello\n");
    repo.write(".claude/settings.local.json", "{}\n");
    repo.git(&["add", "-f", ".claude/settings.local.json", "README.md"]);
    repo.git(&["commit", "-q", "-m", "base"]);
    repo.write(".claude/settings.local.json", "{\"allow\":[]}\n");
    stage_all(repo.path()).expect("staging runs");
    assert_eq!(
        repo.staged(),
        vec![".claude/settings.local.json".to_string()]
    );
}

#[test]
fn a_selected_agent_file_is_refused_with_the_plain_line() {
    let repo = Repo::new("refuse");
    repo.write("README.md", "hello\n");
    repo.commit("base");
    repo.write(".claude/settings.local.json", "{}\n");
    let err =
        refuse_selected(repo.path(), &[".claude/settings.local.json".to_string()]).unwrap_err();
    assert!(
        err.starts_with(
            "Left out .claude/settings.local.json: an agent's local approvals, not for GitHub."
        ),
        "{err}"
    );
    assert!(repo.staged().is_empty());
}

#[test]
fn a_saved_transcript_gets_its_own_plain_line() {
    let repo = Repo::new("transcript");
    repo.write("README.md", "hello\n");
    repo.commit("base");
    repo.write(".claude/projects/app/session.jsonl", "{\"turn\":1}\n");
    let err = refuse_selected(
        repo.path(),
        &[".claude/projects/app/session.jsonl".to_string()],
    )
    .unwrap_err();
    assert!(
        err.starts_with(
            "Left out .claude/projects/app/session.jsonl: an agent's saved transcript, not for GitHub."
        ),
        "{err}"
    );
}

#[test]
fn a_manually_staged_agent_file_stops_the_commit() {
    let repo = Repo::new("manual");
    repo.write("README.md", "hello\n");
    repo.commit("base");
    repo.write(".claude/settings.local.json", "{}\n");
    repo.git(&["add", "-f", ".claude/settings.local.json"]);
    let err = refuse_staged_agent_files(repo.path()).unwrap_err();
    assert!(
        err.starts_with(
            "Left out .claude/settings.local.json: an agent's local approvals, not for GitHub."
        ),
        "{err}"
    );
}

#[test]
fn a_fake_key_on_an_added_line_is_caught_without_its_value() {
    let key = fake_key();
    let patch = patch_lines(
        "src/config.rs",
        2,
        &[&format!("const KEY: &str = \"{key}\";")],
    );
    let err = scan_patch(&patch).unwrap_err();
    assert!(
        err.starts_with("Possible secret in src/config.rs:2"),
        "{err}"
    );
    assert!(!err.contains(key_body(&key)), "the value leaked: {err}");
}

#[test]
fn a_secret_on_a_removed_line_is_not_reported() {
    let patch = format!(
        "diff --git a/src/config.rs b/src/config.rs\nindex 1111111..2222222 100644\n--- a/src/config.rs\n+++ b/src/config.rs\n@@ -1 +0,0 @@\n-const KEY: &str = \"{}\";\n",
        fake_key()
    );
    scan_patch(&patch).expect("a removed line is not shipped");
}

#[test]
fn a_generic_assignment_on_a_plus_line_is_caught() {
    let patch = patch_lines("config.toml", 3, &["password = \"hunter2hunter2\""]);
    let err = scan_patch(&patch).unwrap_err();
    assert!(err.starts_with("Possible secret in config.toml:3"), "{err}");
    assert!(!err.contains("hunter2"), "the value leaked: {err}");
}

#[test]
fn a_private_key_block_across_added_lines_is_caught_at_its_first_line() {
    let patch = patch_lines(
        "keys/deploy.pem",
        1,
        &[
            "-----BEGIN PRIVATE KEY-----",
            "AAAAfakebody",
            "-----END PRIVATE KEY-----",
        ],
    );
    let err = scan_patch(&patch).unwrap_err();
    assert!(
        err.starts_with("Possible secret in keys/deploy.pem:1"),
        "{err}"
    );
}

#[test]
fn a_refusal_changes_no_ignore_file_on_disk() {
    let repo = Repo::new("ignore");
    repo.write("README.md", "hello\n");
    repo.write(".gitignore", "target/\n");
    repo.commit("base");
    let exclude_before = fs::read(repo.path().join(".git/info/exclude")).ok();
    let gitignore_before = fs::read(repo.path().join(".gitignore")).unwrap();
    repo.write(".claude/settings.local.json", "{}\n");
    let _ = refuse_selected(repo.path(), &[".claude/settings.local.json".to_string()]);
    stage_all(repo.path()).expect("staging runs");
    let _ = refuse_staged_agent_files(repo.path());
    assert_eq!(
        fs::read(repo.path().join(".git/info/exclude")).ok(),
        exclude_before
    );
    assert_eq!(
        fs::read(repo.path().join(".gitignore")).unwrap(),
        gitignore_before
    );
}

#[test]
fn a_clean_unpushed_commit_passes_the_outgoing_gate() {
    let (local, _remote) = pushed_repo("clean");
    local.write("src/app.txt", "shipped\n");
    local.commit("add app");
    gate_outgoing(local.path()).expect("nothing to refuse");
}

#[test]
fn a_secret_in_an_unpushed_commit_stops_the_push() {
    let (local, _remote) = pushed_repo("secret");
    let key = fake_key();
    local.write("src/config.rs", &format!("const KEY: &str = \"{key}\";\n"));
    local.commit("add config");
    let err = gate_outgoing(local.path()).unwrap_err();
    assert!(
        err.starts_with("Possible secret in src/config.rs:1"),
        "{err}"
    );
    assert!(!err.contains(key_body(&key)), "the value leaked: {err}");
}

#[test]
fn a_secret_that_a_new_commit_only_removes_is_not_refused() {
    let (local, _remote) = pushed_repo("removed");
    let key = fake_key();
    local.write("src/config.rs", &format!("const KEY: &str = \"{key}\";\n"));
    local.commit("add config");
    local.git(&["push", "-q", "origin", "main"]);
    local.write("src/config.rs", "const KEY: &str = \"\";\n");
    local.commit("remove key");
    gate_outgoing(local.path()).expect("a removed secret is not shipped");
}

#[test]
fn an_agent_file_in_an_unpushed_commit_stops_the_push() {
    let (local, _remote) = pushed_repo("agentcommit");
    local.write(".claude/settings.local.json", "{}\n");
    local.git(&["add", "-f", ".claude/settings.local.json"]);
    local.git(&["commit", "-q", "-m", "oops"]);
    let err = gate_outgoing(local.path()).unwrap_err();
    assert!(
        err.starts_with(
            "Refused to push .claude/settings.local.json: it is an agent's local approvals, not for GitHub."
        ),
        "{err}"
    );
}

fn collect_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// The source lines that are not test code: each `#[cfg(test)]` item (a module, a fn, a use) is skipped through its
/// closing brace, or to its `;` line when it has no body.
fn production_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if !line.trim_start().starts_with("#[cfg(test)]") {
            out.push(line);
            continue;
        }
        let mut depth: i32 = 0;
        let mut opened = false;
        for item in lines.by_ref() {
            for ch in item.chars() {
                match ch {
                    '{' => {
                        depth += 1;
                        opened = true;
                    }
                    '}' => depth -= 1,
                    _ => {}
                }
            }
            if (opened && depth <= 0) || (!opened && item.trim_end().ends_with(';')) {
                break;
            }
        }
    }
    out
}

/// Every production git push or gh pr create must sit in a file that calls the guard. Test code (below each file's
/// `#[cfg(test)]` line, and the tests.rs files) and git stash, which is local, are not delivery.
#[test]
fn every_push_and_pr_site_goes_through_the_guard() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_sources(&src, &mut files);
    let mut unguarded = Vec::new();
    let mut sites = Vec::new();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name == "tests.rs"
            || name.ends_with("_tests.rs")
            || path.components().any(|c| c.as_os_str() == "commit_guard")
        {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        let production = production_lines(&text);
        let rel = path.strip_prefix(&src).unwrap().display().to_string();
        let mut is_site = false;
        for (number, line) in production.iter().enumerate() {
            if line.contains("Some(") || line.contains("stash") {
                continue;
            }
            let before = if number == 0 {
                ""
            } else {
                production[number - 1]
            };
            let push = line.contains("\"push\"");
            let create = line.contains("\"create\"")
                && (line.contains("\"pr\"") || before.contains("\"pr\""));
            if push || create {
                is_site = true;
                sites.push(format!("{rel}:{}", number + 1));
            }
        }
        if is_site && !production.iter().any(|l| l.contains("commit_guard::gate_")) {
            unguarded.push(rel);
        }
    }
    assert!(
        !sites.is_empty(),
        "the scan found no delivery sites: the scan itself is broken"
    );
    assert!(
        unguarded.is_empty(),
        "git push or gh pr create without the commit guard: {unguarded:?} (sites: {sites:?})"
    );
}

#[test]
fn land_and_self_build_check_what_they_ship() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for file in ["land.rs", "self_build.rs"] {
        let text = fs::read_to_string(src.join(file)).unwrap();
        assert!(
            text.contains("commit_guard::"),
            "{file} stages or lands without the commit guard"
        );
    }
}
