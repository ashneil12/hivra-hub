//! Review of PR #227 (WP-200), round 6: a red-first repro at 54145260c for the delivery push. It fails on that head at
//! its own assertion.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::deliver::{self, DeliverInput};
use super::github::fake::FakeGithub;
use super::settings::{self, Mode};
use crate::session_store::SessionStore;

struct Temp(PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
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

// MEDIUM (r5 M2, partly open): round 6 added `--no-follow-tags --recurse-submodules=no` to fs.rs's push only. The
// delivery push (deliver.rs, `git push --set-upstream <remote> HEAD:refs/heads/<branch>` in the worker's copy) still
// follows the copy's config, so `push.followTags=true` sends an annotated tag whose message the gate never read.
#[test]
fn r6_m2_the_delivery_push_does_not_send_an_unchecked_tag_message() {
    let dir = std::env::temp_dir().join(format!(
        "hivra-r6-delivery-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let temp = Temp(crate::fs::canonical(&dir).unwrap());
    let bare = temp.0.join("remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "main"]);
    let project = temp.0.join("web");
    std::fs::create_dir_all(&project).unwrap();
    git(&project, &["init", "-q", "-b", "main"]);
    git(&project, &["config", "core.autocrlf", "false"]);
    git(&project, &["config", "push.negotiate", "false"]);
    git(
        &project,
        &["remote", "add", "origin", "https://github.com/acme/web.git"],
    );
    let bare_url = format!("file://{}", bare.to_string_lossy().replace('\\', "/"));
    git(
        &project,
        &[
            "config",
            &format!("url.{bare_url}.insteadOf"),
            "https://github.com/acme/web.git",
        ],
    );
    std::fs::write(project.join("a.txt"), "one\n").unwrap();
    git(&project, &["add", "a.txt"]);
    git(&project, &["commit", "-qm", "start"]);
    git(&project, &["push", "-q", "origin", "main"]);
    git(&project, &["fetch", "-q", "origin"]);
    let copies = temp.0.join("web-worktrees");
    std::fs::create_dir_all(&copies).unwrap();
    let copy = copies.join("work");
    git(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "work",
            copy.to_str().unwrap(),
            "main",
        ],
    );
    let copy = crate::fs::canonical(&copy).unwrap();
    let project = crate::fs::canonical(&project).unwrap();

    std::fs::write(copy.join("a.txt"), "two\n").unwrap();
    git(&copy, &["add", "a.txt"]);
    git(&copy, &["commit", "-qm", "change a.txt"]);
    let key = format!("sk-ant-{}", "Ab3dEf7h".repeat(4));
    git(&copy, &["tag", "-a", "v9", "-m", &format!("release {key}")]);
    git(&copy, &["config", "push.followTags", "true"]);

    let store = SessionStore::open_in_memory().unwrap();
    {
        let conn = store.lock_conn().unwrap();
        let current = settings::get(&conn, project.to_str().unwrap()).unwrap();
        settings::set(
            &conn,
            project.to_str().unwrap(),
            Some(Mode::Pr),
            false,
            current.updated_at,
            current.updated_at.unwrap_or(0) + 1,
        )
        .unwrap();
    }
    let gh = FakeGithub::new(vec![]);
    let delivered = deliver::deliver(
        &store,
        &gh,
        DeliverInput {
            project: project.to_string_lossy().into(),
            checkout: copy.to_string_lossy().into(),
            title: Some("Change a".into()),
            brief: Some("Change a.txt.".into()),
            ..Default::default()
        },
        10,
    );
    assert!(
        git_ok(&bare, &["rev-parse", "refs/heads/work"]).is_some(),
        "fixture: the delivery pushed the branch: {:?}",
        delivered.as_ref().map(|d| d.state.clone())
    );
    let tag = git_ok(&bare, &["cat-file", "-p", "refs/tags/v9"]).unwrap_or_default();
    assert!(
        !tag.contains("sk-ant-"),
        "the delivery push sent an annotated tag whose message holds a secret"
    );
}
