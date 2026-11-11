use super::*;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
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
    let patch = patch_lines("config.toml", 3, &["password = \"hunter2hunter2hunter2\""]);
    let err = scan_patch(&patch).unwrap_err();
    assert!(err.starts_with("Possible secret in config.toml:3"), "{err}");
    assert!(!err.contains("hunter2"), "the value leaked: {err}");
}

#[test]
fn an_end_line_before_begin_does_not_hide_a_private_key() {
    let patch = patch_lines(
        "keys/deploy.pem",
        1,
        &[
            "-----END PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----",
            "AAAAfakebody",
        ],
    );
    let err = scan_patch(&patch).unwrap_err();
    assert!(
        err.starts_with("Possible secret in keys/deploy.pem:2"),
        "{err}"
    );
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

fn hash_object(repo: &Path, kind: &str, bytes: &[u8], literally: bool) -> String {
    let mut args = vec!["hash-object", "-t", kind, "-w", "--stdin"];
    if literally {
        // A UTF-16 commit message contains NUL bytes. Ordinary hash-object refuses those; the guard still has to
        // read an object that is already in the store.
        args.insert(1, "--literally");
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("git runs");
    child.stdin.take().unwrap().write_all(bytes).expect("stdin");
    let out = child.wait_with_output().expect("git finishes");
    assert!(
        out.status.success(),
        "hash-object failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn utf16le(text: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    for unit in text.encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    bytes
}

#[test]
fn a_utf16_commit_message_is_read_as_text() {
    let (local, _remote) = pushed_repo("utf16");
    local.write("src/app.txt", "shipped\n");
    local.commit("add app");
    let key = fake_key();
    let tree = local.git(&["rev-parse", "HEAD^{tree}"]);
    let parent = local.git(&["rev-parse", "HEAD"]);
    let mut object = format!(
        "tree {}\nparent {}\nauthor Guard Test <guard@example.test> 1 +0000\ncommitter Guard Test <guard@example.test> 1 +0000\nencoding UTF-16\n\n",
        tree.trim(),
        parent.trim()
    )
    .into_bytes();
    object.extend(utf16le(&format!("release {key}\n")));
    let sha = hash_object(local.path(), "commit", &object, true);
    local.git(&["update-ref", "HEAD", &sha]);
    let err = gate_outgoing(local.path()).unwrap_err();
    assert!(err.contains("a commit message"), "{err}");
    assert!(!err.contains(key_body(&key)), "the value leaked: {err}");
}

#[test]
fn a_utf16_tag_message_is_read_as_text() {
    let (local, remote) = pushed_repo("utf16tag");
    let key = fake_key();
    let head = local.git(&["rev-parse", "HEAD"]);
    let mut object = format!(
        "object {}\ntype commit\ntag v1\ntagger Guard Test <guard@example.test> 1 +0000\nencoding UTF-16\n\n",
        head.trim()
    )
    .into_bytes();
    object.extend(utf16le(&format!("release {key}\n")));
    let sha = hash_object(local.path(), "tag", &object, false);
    local.git(&["update-ref", "refs/tags/v1", &sha]);
    let zero = "0".repeat(40);
    let stdin = format!("refs/tags/v1 {sha} refs/tags/v1 {zero}\n");
    let err =
        pre_push_stdin_check(local.path(), remote.path().to_str().unwrap(), &stdin).unwrap_err();
    assert!(err.contains("a commit message"), "{err}");
    assert!(!err.contains(key_body(&key)), "the value leaked: {err}");
}

#[test]
fn the_push_gate_returns_the_commit_it_checked() {
    let (local, _remote) = pushed_repo("pinned");
    let head = local.git(&["rev-parse", "HEAD"]);
    let sha = gate_outgoing_to(local.path(), "origin").expect("a clean push is checked");
    assert_eq!(sha, head.trim());
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

/// The function that holds line `at`: from its header to its closing brace (a line at the header's indentation that
/// starts with `}`). A site counts as guarded when its own function calls the guard, not merely its file.
fn enclosing_fn(lines: &[&str], at: usize) -> (usize, usize) {
    const HEADERS: [&str; 7] = [
        "fn ",
        "pub fn ",
        "pub(crate) fn ",
        "pub(super) fn ",
        "async fn ",
        "pub async fn ",
        "pub(crate) async fn ",
    ];
    let mut head = 0;
    for i in (0..=at).rev() {
        let trimmed = lines[i].trim_start();
        if HEADERS.iter().any(|h| trimmed.starts_with(h)) {
            head = i;
            break;
        }
    }
    let indent = lines[head].len() - lines[head].trim_start().len();
    let mut end = lines.len() - 1;
    for (i, line) in lines.iter().enumerate().skip(head + 1) {
        let here = line.len() - line.trim_start().len();
        if here == indent && line.trim_start().starts_with('}') {
            end = i;
            break;
        }
    }
    (head, end)
}

/// Every production git push or gh pr create must sit in a function that calls the guard. Test code (below each file's
/// `#[cfg(test)]` line, and the tests.rs files) and git stash, which is local, are not delivery. A match arm that
/// names "push" as one of several git commands (a classifier, not a call) is not a site.
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
        for (number, line) in production.iter().enumerate() {
            if line.contains("stash") || line.contains("| \"push\"") || line.contains("\"push\" |")
            {
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
                sites.push(format!("{rel}:{}", number + 1));
                let (head, end) = enclosing_fn(&production, number);
                let guarded = production[head..=end]
                    .iter()
                    .any(|l| l.contains("commit_guard::"));
                if !guarded {
                    unguarded.push(format!("{rel}:{}", number + 1));
                }
            }
        }
    }
    assert!(
        !sites.is_empty(),
        "the scan found no delivery sites: the scan itself is broken"
    );
    assert!(
        unguarded.is_empty(),
        "git push or gh pr create in a function without the commit guard: {unguarded:?} (sites: {sites:?})"
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
    // The self-build cherry-pick gate is the exact call apply makes before it picks.
    let self_build = fs::read_to_string(src.join("self_build.rs")).unwrap();
    assert!(
        self_build.contains("commit_guard::gate_range(repo, &[range.as_str()])"),
        "self_build::apply picks commits without the commit guard's range gate"
    );
}

#[test]
fn the_pre_push_check_refuses_an_agent_file_and_a_secret_and_passes_a_clean_push() {
    let remote = Repo::bare("hook-remote");
    let local = Repo::new("hook-check");
    local.git(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
    local.write("README.md", "hello\n");
    local.commit("base");
    local.git(&["push", "-q", "-u", "origin", "main"]);
    local.write("src/app.txt", "shipped\n");
    local.commit("clean");
    pre_push_check(local.path(), "origin").expect("a clean push passes");
    local.write(".claude/settings.local.json", "{}\n");
    local.git(&["add", "-f", ".claude/settings.local.json"]);
    local.git(&["commit", "-q", "-m", "agent file"]);
    let err = pre_push_check(local.path(), "origin").unwrap_err();
    assert!(
        err.starts_with("Refused to push .claude/settings.local.json"),
        "{err}"
    );
}

/// The generated pre-push hook runs the guard first; the guard's refusal stops the push, and a pass runs the
/// repository's own pre-push hook with the same arguments. The guard here is a stand-in script (the real one is the
/// app's binary), so this tests the forwarding, and the check itself is tested above.
#[test]
fn the_pre_push_hook_runs_the_guard_then_the_repos_own_hook() {
    let dir = Repo::dir("hook-script");
    let guard = dir.path().join("guard.sh");
    fs::write(
        &guard,
        "#!/bin/sh\nif [ -f \"$(dirname \"$0\")/fail\" ]; then exit 1; fi\nexit 0\n",
    )
    .unwrap();
    let real = dir.path().join("real-pre-push");
    fs::write(
        &real,
        format!(
            "#!/bin/sh\necho \"$1\" > \"{}\"\n",
            dir.path().join("real-ran").display()
        ),
    )
    .unwrap();
    let hook = dir.path().join("pre-push");
    for script in [&guard, &real] {
        Command::new("chmod")
            .arg("+x")
            .arg(script)
            .status()
            .unwrap();
    }
    let store = dir.path().join("commit-guard-allows.json");
    let text = crate::attribution::hooks::pre_push_script(
        guard.to_str().unwrap(),
        real.to_str(),
        store.to_str().unwrap(),
    )
    .expect("the hook script builds");
    fs::write(&hook, text).unwrap();
    Command::new("chmod").arg("+x").arg(&hook).status().unwrap();

    fs::write(dir.path().join("fail"), "").unwrap();
    let refused = Command::new(&hook)
        .arg("origin")
        .stdin(Stdio::null())
        .status()
        .unwrap();
    assert!(
        !refused.success(),
        "the guard's refusal did not stop the push"
    );
    assert!(
        !dir.path().join("real-ran").exists(),
        "the repository's hook ran after a refusal"
    );

    fs::remove_file(dir.path().join("fail")).unwrap();
    let passed = Command::new(&hook)
        .arg("origin")
        .stdin(Stdio::null())
        .status()
        .unwrap();
    assert!(
        passed.success(),
        "a passing guard did not let the push go on"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("real-ran"))
            .unwrap()
            .trim(),
        "origin",
        "the repository's own hook did not run with the remote"
    );
}

#[test]
fn a_transcript_in_the_hivra_folder_is_left_out_of_staging() {
    let repo = Repo::new("hivra-folder");
    repo.write("README.md", "hello\n");
    repo.commit("base");
    repo.write(".hivra/session.jsonl", "{\"turn\":1}\n");
    repo.write("src/app.txt", "shipped\n");
    stage_all(repo.path()).expect("staging runs");
    assert_eq!(repo.staged(), vec!["src/app.txt".to_string()]);
}

// ---- review round 3 -------------------------------------------------------------------------------------------------

#[test]
fn an_allowed_line_is_not_a_finding_and_only_that_line_is() {
    let key = fake_key();
    let line = format!("const KEY: &str = \"{key}\";");
    let patch = patch_lines("src/config.rs", 2, &[&line]);
    let allow = Allow {
        repo: "repo-a".into(),
        file: "src/config.rs".into(),
        hash: line_hash(&line),
        mac: String::new(),
    };
    scan_patch_with(&patch, std::slice::from_ref(&allow), "repo-a")
        .expect("the allowed line passes");
    let other_file = Allow {
        file: "src/other.rs".into(),
        ..allow.clone()
    };
    assert!(
        scan_patch_with(&patch, &[other_file], "repo-a").is_err(),
        "an allow for another file passed"
    );
    assert!(
        scan_patch_with(&patch, std::slice::from_ref(&allow), "repo-b").is_err(),
        "an allow for another repository passed"
    );
    let changed = format!("{line} // changed");
    let other_line = Allow {
        hash: line_hash(&changed),
        ..allow.clone()
    };
    assert!(
        scan_patch_with(&patch, &[other_line], "repo-a").is_err(),
        "an allow for other text on the line passed"
    );
}

#[test]
fn an_allow_store_that_does_not_parse_allows_nothing() {
    let dir = Repo::dir("allow-store");
    let path = dir.path().join("commit-guard-allows.json");
    fs::write(&path, "{ not json").unwrap();
    assert!(
        read_allows(&path).is_empty(),
        "a broken store allowed something"
    );
    let allow = signed(
        TEST_KEY,
        Allow {
            repo: "repo-a".into(),
            file: "src/config.rs".into(),
            hash: line_hash("x"),
            mac: String::new(),
        },
    );
    write_allows(&path, std::slice::from_ref(&allow)).unwrap();
    assert_eq!(read_allows_with(&path, TEST_KEY), vec![allow]);
    assert!(
        read_allows_with(&path, b"another-key").is_empty(),
        "an entry signed with another key was honoured"
    );
}

#[test]
fn a_hand_written_allow_is_not_honoured() {
    let dir = Repo::dir("allow-hand");
    let path = dir.path().join("commit-guard-allows.json");
    fs::write(
        &path,
        "[{\"repo\":\"r\",\"file\":\"src/a.rs\",\"hash\":\"h\"}]",
    )
    .unwrap();
    assert!(read_allows_with(&path, TEST_KEY).is_empty());
}

#[test]
fn an_agent_path_cannot_set_an_allow() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_sources(&src, &mut files);
    for path in files {
        let rel = path.strip_prefix(&src).unwrap().display().to_string();
        if rel.starts_with("commit_guard") || rel == "lib.rs" {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("PersonChoice(")
                && !text.contains("allow_finding(")
                && !text.contains("commit_guard_allow"),
            "{rel} reaches the allow outside the app's UI command"
        );
    }
}

#[test]
fn a_secret_in_a_commit_message_stops_the_push_without_showing_it() {
    let (local, _remote) = pushed_repo("message");
    local.write("src/app.txt", "shipped\n");
    local.commit("add app");
    let key = fake_key();
    local.git(&[
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        &format!("fix the thing\n\nkey {key}"),
    ]);
    let err = gate_outgoing(local.path()).unwrap_err();
    assert!(
        err.starts_with("Possible secret in a commit message:"),
        "{err}"
    );
    assert!(!err.contains(key_body(&key)), "the value leaked: {err}");
}

#[test]
fn a_check_past_its_size_cap_is_refused_not_cut() {
    let (local, _remote) = pushed_repo("cap");
    let err =
        checked_output_within(local.path(), &["log", "--format=%B"], CHECK_TIMEOUT, 4).unwrap_err();
    assert_eq!(err, TOO_LARGE);
}

#[test]
fn a_check_past_its_time_limit_is_killed_and_refused() {
    let (local, _remote) = pushed_repo("time");
    let err = checked_output_within(
        local.path(),
        &["log", "--format=%B"],
        Duration::ZERO,
        MAX_CHECKED_BYTES,
    )
    .unwrap_err();
    assert_eq!(err, TIMED_OUT);
}

#[test]
fn the_push_names_its_refspec_so_a_push_default_cannot_change_it() {
    let (local, remote) = pushed_repo("refspec");
    local.git(&["config", "push.default", "nothing"]);
    local.write("src/app.txt", "shipped\n");
    local.commit("add app");
    crate::fs::git_push_for(local.path()).expect("the push goes out");
    let remote_main = Command::new("git")
        .arg("-C")
        .arg(remote.path())
        .args(["rev-parse", "main"])
        .output()
        .unwrap();
    let head = local.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        String::from_utf8_lossy(&remote_main.stdout).trim(),
        head.trim(),
        "the push did not send HEAD to main"
    );
}

#[test]
fn a_secret_in_a_branch_the_self_build_would_pick_is_refused_before_the_pick() {
    let (local, _remote) = pushed_repo("pick");
    local.git(&["checkout", "-q", "-b", "hub-change/x"]);
    let key = fake_key();
    local.write("src/config.rs", &format!("const KEY: &str = \"{key}\";\n"));
    local.commit("change");
    let base = "main";
    let range = format!("{base}..hub-change/x");
    let err = gate_range(local.path(), &[range.as_str()]).unwrap_err();
    assert!(
        err.starts_with("Possible secret in src/config.rs:1"),
        "{err}"
    );
}

/// The key the tests sign with. The app's real key is in the Keychain; tests never reach it.
const TEST_KEY: &[u8] = b"test-key-not-a-secret";

fn refusal_id_of(message: &str) -> String {
    message
        .split("refusal ")
        .nth(1)
        .unwrap_or("")
        .chars()
        .take(12)
        .collect()
}

#[test]
fn an_allow_is_recorded_for_the_refused_text_and_can_be_removed() {
    let (local, _remote) = pushed_repo("allow-round");
    let key = fake_key();
    local.write("src/config.rs", &format!("const KEY: &str = \"{key}\";\n"));
    local.commit("config");
    let refused = gate_outgoing(local.path()).unwrap_err();
    let id = refusal_id_of(&refused);
    assert_eq!(id.len(), 12, "the refusal names its id: {refused}");
    let dir = Repo::dir("allow-store-file");
    let store = dir.path().join("commit-guard-allows.json");
    allow_refusal_with(&store, &id, TEST_KEY).expect("the refusal is allowed");
    let expected = signed(
        TEST_KEY,
        Allow {
            repo: repo_id(local.path()),
            file: "src/config.rs".into(),
            hash: line_hash(&format!("const KEY: &str = \"{key}\";")),
            mac: String::new(),
        },
    );
    assert_eq!(read_allows_with(&store, TEST_KEY), vec![expected.clone()]);
    assert!(
        gate_outgoing(local.path()).is_err(),
        "a file-level allow alone must not pass a refusal with no entry"
    );
    remove_allow_in(&store, &expected).expect("the allow is removed");
    assert!(read_allows_with(&store, TEST_KEY).is_empty());
}

// ---- review round 4 ---------------------------------------------------------------------------------------------------

#[test]
fn the_pre_push_stdin_check_covers_the_ref_git_is_pushing_whatever_head_is() {
    let (local, _remote) = pushed_repo("stdin-ref");
    local.git(&["checkout", "-q", "-b", "leak"]);
    let key = fake_key();
    local.write("src/config.rs", &format!("const KEY: &str = \"{key}\";\n"));
    local.commit("leak");
    let leak_sha = local.git(&["rev-parse", "leak"]);
    local.git(&["checkout", "-q", "main"]);
    let zeros = "0".repeat(40);
    let stdin = format!(
        "refs/heads/leak {} refs/heads/leak {zeros}\n",
        leak_sha.trim()
    );
    let err = pre_push_stdin_check(local.path(), "origin", &stdin).unwrap_err();
    assert!(
        err.starts_with("Possible secret in src/config.rs:1"),
        "{err}"
    );
    let deletion = format!("(delete) {zeros} refs/heads/leak {}\n", leak_sha.trim());
    pre_push_stdin_check(local.path(), "origin", &deletion).expect("a deletion sends no commit");
}

#[test]
fn colour_codes_in_the_checked_output_stop_the_step_rather_than_hiding_a_line() {
    let (local, _remote) = pushed_repo("escape");
    local.write("src/app.txt", "shipped\n");
    local.commit("add app");
    local.git(&["commit", "-q", "--allow-empty", "-m", "\u{1b}[31mfix thing"]);
    let err = gate_outgoing(local.path()).unwrap_err();
    assert!(err.contains("colour codes"), "{err}");
}

#[test]
fn a_secret_shape_in_a_file_name_stops_the_push_without_showing_the_name() {
    let (local, _remote) = pushed_repo("file-name");
    let key = fake_key();
    local.write(&format!("notes/{key}.txt"), "clean\n");
    local.commit("named");
    let err = gate_outgoing(local.path()).unwrap_err();
    assert!(err.starts_with("Possible secret in a file name"), "{err}");
    assert!(!err.contains(key_body(&key)), "the name leaked: {err}");
}

#[test]
fn an_allow_names_a_refusal_it_was_shown_and_nothing_else() {
    let dir = Repo::dir("allow-id");
    let store = dir.path().join("commit-guard-allows.json");
    let err = allow_refusal_with(&store, "0123456789ab", TEST_KEY).unwrap_err();
    assert!(err.contains("no longer on record"), "{err}");
    assert!(!store.exists(), "an unknown id wrote an allow");
}

#[test]
fn a_raw_escape_byte_inside_a_file_is_data_and_is_checked_as_text() {
    let (local, _remote) = pushed_repo("escape-data");
    local.write("src/ansi.txt", "red: \u{1b}[31m text\n");
    local.commit("ansi fixture");
    gate_outgoing(local.path()).expect("a file with an escape byte in it is checked, not refused");
}

// ---- review round 5 -------------------------------------------------------------------------------------------------

#[test]
fn a_utf16_file_with_a_secret_is_refused_as_text() {
    let (local, _remote) = pushed_repo("utf16");
    let bytes: Vec<u8> = format!("const KEY: &str = \"{}\";\n", fake_key())
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    std::fs::write(local.path().join("src-config.txt"), bytes).unwrap();
    local.commit("utf16 file");
    let err = gate_outgoing(local.path()).unwrap_err();
    assert!(
        err.starts_with("Possible secret in src-config.txt"),
        "{err}"
    );
}

#[test]
fn a_secret_in_an_annotated_tag_message_stops_the_push() {
    let (local, _remote) = pushed_repo("tag-msg");
    local.git(&[
        "tag",
        "-a",
        "v1",
        "-m",
        &format!("release key {}", fake_key()),
    ]);
    let tag = local.git(&["rev-parse", "v1"]);
    let zeros = "0".repeat(40);
    let stdin = format!("refs/tags/v1 {} refs/tags/v1 {zeros}\n", tag.trim());
    let err = pre_push_stdin_check(local.path(), "origin", &stdin).unwrap_err();
    assert!(
        err.starts_with("Possible secret in a commit message"),
        "{err}"
    );
    assert!(
        !err.contains(key_body(&fake_key())),
        "the tag message leaked: {err}"
    );
}

#[test]
fn a_refusal_records_its_folder_file_line_and_commit_for_the_banner() {
    let (local, _remote) = pushed_repo("banner");
    let key = fake_key();
    local.write("src/config.rs", &format!("const KEY: &str = \"{key}\";\n"));
    local.commit("config");
    let commit = local.git(&["rev-parse", "HEAD"]);
    let message = gate_outgoing(local.path()).unwrap_err();
    let id = refusal_id_of(&message);
    let record = find_refusal(&id).expect("the refusal is on record");
    assert_eq!(record.file, "src/config.rs");
    assert_eq!(record.line, 1);
    assert!(
        commit.trim().starts_with(&record.commit),
        "the record names the commit"
    );
    assert!(record
        .folder
        .ends_with(local.path().file_name().unwrap().to_str().unwrap()));
}
