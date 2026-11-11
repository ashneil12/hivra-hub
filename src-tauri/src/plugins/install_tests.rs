//! WP-31's proofs: a pin is a commit, a plugin that can't run here is refused before anything is downloaded, a failed
//! update puts the installed version back, a script waits for a yes, an agent's install waits too, and rollback and
//! uninstall leave the lock file and the folders as they were.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::compat::Target;
use super::fsutil;
use super::install::{self, InstallResult, RequestedBy};
use super::manifest::PLUGIN_SCHEMA_1_0_0;
use super::registry::{self, Contribution, Host, Scope};
use super::source::{self, InstallSource, Tools};
use super::wiring;

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("hivra-wp31-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(fsutil::canonical(&dir).unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn host(tmp: &Tmp) -> Host {
    let host = Host {
        root: tmp.path().join("app-data/plugins"),
        agents_skills: tmp.path().join("home/.agents/skills"),
    };
    std::fs::create_dir_all(&host.root).unwrap();
    std::fs::create_dir_all(tmp.path().join("home")).unwrap();
    host
}

/// Programs that must not be started. A test that succeeds with these never downloaded anything.
fn quiet_tools() -> Tools {
    Tools {
        git: OsString::from("git-must-not-run"),
        npm: OsString::from("npm-must-not-run"),
        path: None,
        target: Target::here(),
    }
}

fn git_tools() -> Tools {
    Tools {
        git: OsString::from("git"),
        npm: OsString::from("npm-must-not-run"),
        path: std::env::var_os("PATH"),
        target: Target::here(),
    }
}

fn plugin(dir: &Path, name: &str, version: &str, extra: serde_json::Value) {
    let mut value = json!({
        "$schema": PLUGIN_SCHEMA_1_0_0,
        "name": name,
        "version": version,
    });
    if let Some(fields) = extra.as_object() {
        for (key, field) in fields {
            value[key] = field.clone();
        }
    }
    write(&dir.join("plugin.json"), &value.to_string());
    write(
        &dir.join("skills/alpha/SKILL.md"),
        "---\nname: alpha\ndescription: First.\n---\n\n# alpha\n",
    );
}

fn local_source(dir: &Path) -> InstallSource {
    InstallSource::Local {
        path: dir.display().to_string(),
    }
}

fn installed_version(host: &Host, name: &str) -> Option<String> {
    registry::read(host)
        .unwrap()
        .plugins
        .get(name)
        .and_then(|entry| entry.version.clone())
}

fn note(host: &Host, name: &str) -> String {
    std::fs::read_to_string(host.installed(name).join("note.txt")).unwrap()
}

fn activity_db(tmp: &Tmp) -> PathBuf {
    tmp.path().join("app-data/monocode.db")
}

/// The table has to exist before the action. A missing file is not created by the note.
fn ready_activity(tmp: &Tmp) {
    drop(crate::session_store::SessionStore::open(activity_db(tmp)).unwrap());
}

fn activity_rows(tmp: &Tmp) -> Vec<crate::activity::Entry> {
    let store = crate::session_store::SessionStore::open(activity_db(tmp)).unwrap();
    let conn = store.lock_conn().unwrap();
    crate::activity::list(
        &conn,
        &crate::activity::ListQuery {
            limit: Some(50),
            ..Default::default()
        },
        crate::session_store::now_millis(),
    )
    .unwrap()
    .entries
}

/// The platform this test is not running on, so a plugin that names only it is always refused.
fn other_platform() -> &'static str {
    if cfg!(windows) {
        "linux"
    } else {
        "windows"
    }
}

fn git_cmd(dir: &Path, args: &[&str]) -> String {
    let output = crate::git_cmd::git()
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Hivra")
        .env("GIT_AUTHOR_EMAIL", "hivra@example.com")
        .env("GIT_COMMITTER_NAME", "Hivra")
        .env("GIT_COMMITTER_EMAIL", "hivra@example.com")
        .output()
        .unwrap_or_else(|e| panic!("git didn't start: {e}"));
    assert!(
        output.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn init_repo(repo: &Path) {
    std::fs::create_dir_all(repo).unwrap();
    git_cmd(repo, &["init", "-q"]);
    git_cmd(repo, &["config", "user.email", "hivra@example.com"]);
    git_cmd(repo, &["config", "user.name", "Hivra"]);
    git_cmd(repo, &["config", "commit.gpgsign", "false"]);
    git_cmd(repo, &["config", "core.autocrlf", "false"]);
}

fn commit_all(repo: &Path) -> String {
    git_cmd(repo, &["add", "--", "."]);
    git_cmd(repo, &["commit", "-q", "-m", "pin"]);
    git_cmd(repo, &["rev-parse", "HEAD"])
}

struct ResetFail;

impl Drop for ResetFail {
    fn drop(&mut self) {
        install::FAIL_AFTER_SWAP.with(|flag| flag.set(false));
    }
}

#[test]
fn the_browser_plugin_installs_from_the_index_pin_without_the_network() {
    let index: serde_json::Value = serde_json::from_str(super::discover::BUNDLED_INDEX).unwrap();
    let browser = index["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["name"] == "browser")
        .unwrap();
    let pinned = &browser["versions"][0]["source"];
    assert_eq!(
        pinned["type"], "folder",
        "the pin is the plugin's own folder, not a commit of this repo: {pinned}"
    );
    assert_eq!(pinned["path"], "plugins/browser");
    assert!(pinned.get("commit").is_none(), "{pinned}");
    assert!(pinned.get("url").is_none(), "{pinned}");

    let repo =
        fsutil::canonical(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").as_path()).unwrap();
    let folder = fsutil::canonical(&repo.join("plugins/browser")).unwrap();
    assert!(folder.starts_with(&repo), "{}", folder.display());
    assert!(folder.join("plugin.json").is_file());

    let tmp = Tmp::new("browser-index");
    let host = host(&tmp);
    let source = InstallSource::Local {
        path: folder.display().to_string(),
    };
    let result = install::install(&host, &git_tools(), &source, RequestedBy::person()).unwrap();
    let InstallResult::Installed { entry, .. } = result else {
        panic!("the browser plugin should install, not wait");
    };
    let entry = entry.expect("installed");
    assert_eq!(entry.name, "browser");
    assert_eq!(entry.source.kind, "local");
    assert!(
        entry.source.pin.is_none(),
        "a folder pin is not a commit of this repo: {:?}",
        entry.source.pin
    );
    let mcp: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(host.installed("browser").join("mcp.json")).unwrap(),
    )
    .unwrap();
    assert!(mcp["mcpServers"]["browser"].is_object(), "{mcp}");
}

#[test]
fn a_tag_installs_the_commit_it_points_at_and_uninstall_leaves_no_trace() {
    let tmp = Tmp::new("git-pin");
    let host = host(&tmp);
    let repo = tmp.path().join("my plugins").join("plüg in");
    let pkg = repo.join("pkg");
    init_repo(&repo);
    plugin(&pkg, "demo", "1.0.0", json!({}));
    let sha = commit_all(&repo);
    git_cmd(&repo, &["tag", "v1.0.0"]);
    let before = fsutil::tree(&[host.root.as_path(), tmp.path().join("home").as_path()]);

    let source = InstallSource::Git {
        url: repo.display().to_string(),
        commit: None,
        tag: Some("v1.0.0".into()),
        path: Some("pkg".into()),
    };
    let result = install::install(&host, &git_tools(), &source, RequestedBy::person()).unwrap();
    let InstallResult::Installed { entry, .. } = result else {
        panic!("a person's install with nothing to run should go straight in");
    };
    let entry = entry.unwrap();
    assert_eq!(entry.name, "demo");
    assert_eq!(entry.version.as_deref(), Some("1.0.0"));
    assert_eq!(entry.source.pin.as_deref(), Some(sha.as_str()));
    assert_ne!(entry.source.pin.as_deref(), Some("v1.0.0"));
    assert_eq!(entry.source.tag.as_deref(), Some("v1.0.0"));
    assert_eq!(entry.source.path.as_deref(), Some("pkg"));
    let digest = fsutil::tree_digest(&host.installed("demo"));
    assert_eq!(entry.integrity.as_deref(), Some(digest.as_str()));

    let lock_text = std::fs::read_to_string(host.root.join("lock.json")).unwrap();
    assert!(!lock_text.contains("installedAt"), "{lock_text}");
    let locked = registry::read_lock(&host).unwrap();
    assert_eq!(
        locked.plugins["demo"].source.pin.as_deref(),
        Some(sha.as_str())
    );
    assert_eq!(
        locked.plugins["demo"].integrity.as_deref(),
        Some(digest.as_str())
    );
    assert_eq!(locked.plugins["demo"].version.as_deref(), Some("1.0.0"));

    registry::enable(&host, "demo", &Scope::Global).unwrap();
    assert!(host.agents_skills.join("alpha").exists());
    registry::uninstall(&host, "demo").unwrap();
    assert!(!host.root.join("lock.json").exists());
    assert!(!host.root.join("registry.json").exists());
    assert_eq!(
        fsutil::tree(&[host.root.as_path(), tmp.path().join("home").as_path()]),
        before
    );
}

#[test]
fn incompatible_platform_is_refused_before_any_download() {
    let tmp = Tmp::new("platform");
    let host = host(&tmp);
    let repo = tmp.path().join("repo");
    init_repo(&repo);
    plugin(
        &repo,
        "demo",
        "1.0.0",
        json!({ "extensions": { "hivra": { "platforms": [other_platform()] } } }),
    );
    let sha = commit_all(&repo);
    let source = InstallSource::Git {
        url: repo.display().to_string(),
        commit: Some(sha),
        tag: None,
        path: None,
    };
    let before = fsutil::tree(&[host.root.as_path()]);
    let work = tmp.path().join("scratch");
    let err = source::fetch(&source, &git_tools(), &work).unwrap_err();
    assert!(err.contains("can't be installed here"), "{err}");
    assert!(!work.join("repo").exists(), "cloned before the check");
    assert!(!work.join("plugin").exists(), "unpacked before the check");
    let err = install::install(&host, &git_tools(), &source, RequestedBy::person()).unwrap_err();
    assert!(err.contains("can't be installed here"), "{err}");
    assert_eq!(fsutil::tree(&[host.root.as_path()]), before);
    assert!(install::pending(&host).is_empty());
}

#[test]
fn incompatible_hivra_version_is_refused_before_any_download() {
    let tmp = Tmp::new("version");
    let repo = tmp.path().join("repo");
    init_repo(&repo);
    plugin(
        &repo,
        "demo",
        "1.0.0",
        json!({ "extensions": { "hivra": { "hivraVersion": ">=99" } } }),
    );
    let sha = commit_all(&repo);
    let source = InstallSource::Git {
        url: repo.display().to_string(),
        commit: Some(sha),
        tag: None,
        path: None,
    };
    let work = tmp.path().join("scratch");
    let err = source::fetch(&source, &git_tools(), &work).unwrap_err();
    assert!(err.contains("needs Hivra"), "{err}");
    assert!(!work.join("repo").exists());
    assert!(!work.join("plugin").exists());
}

#[test]
fn unpinned_sources_are_refused_without_running_git_or_npm() {
    let tmp = Tmp::new("unpinned");
    let host = host(&tmp);
    let tools = quiet_tools();
    let cases = [
        InstallSource::Git {
            url: "/tmp/nope".into(),
            commit: Some("main".into()),
            tag: None,
            path: None,
        },
        InstallSource::Git {
            url: "/tmp/nope".into(),
            commit: Some("abc123".into()),
            tag: None,
            path: None,
        },
        InstallSource::Git {
            url: "/tmp/nope".into(),
            commit: Some("a".repeat(40)),
            tag: Some("v1".into()),
            path: None,
        },
        InstallSource::Git {
            url: "/tmp/nope".into(),
            commit: None,
            tag: None,
            path: None,
        },
        InstallSource::Git {
            url: "/tmp/nope".into(),
            commit: Some("a".repeat(40)),
            tag: None,
            path: Some("pkg/../../etc".into()),
        },
        InstallSource::Git {
            url: String::new(),
            commit: Some("a".repeat(40)),
            tag: None,
            path: None,
        },
        InstallSource::Npm {
            package: "demo".into(),
            version: "latest".into(),
            registry: None,
        },
        InstallSource::Npm {
            package: "demo".into(),
            version: "^1.2.3".into(),
            registry: None,
        },
        InstallSource::Npm {
            package: "demo".into(),
            version: String::new(),
            registry: None,
        },
        InstallSource::Npm {
            package: "demo".into(),
            version: "1.2.3".into(),
            registry: Some("http://example.com".into()),
        },
        InstallSource::Local {
            path: "plugins/demo".into(),
        },
    ];
    for source in cases {
        let err = install::install(&host, &tools, &source, RequestedBy::person()).unwrap_err();
        assert!(
            err.contains("can't be installed") && !err.contains("couldn't start"),
            "{source:?}: {err}"
        );
    }
    assert!(install::pending(&host).is_empty());
    assert!(!host.root.join("lock.json").exists());
}

#[test]
fn a_missing_repository_leaves_nothing_waiting() {
    let tmp = Tmp::new("missing");
    let host = host(&tmp);
    let missing = tmp.path().join("missing repo");
    let source = InstallSource::Git {
        url: missing.display().to_string(),
        commit: Some("a".repeat(40)),
        tag: None,
        path: None,
    };
    let err = install::install(&host, &git_tools(), &source, RequestedBy::person()).unwrap_err();
    assert!(!err.is_empty());
    assert!(install::pending(&host).is_empty());
    assert!(!host.pending().exists());
    assert!(!host.installed("demo").exists());
}

#[test]
fn a_failing_update_puts_the_installed_version_back() {
    let tmp = Tmp::new("restore");
    let host = host(&tmp);
    ready_activity(&tmp);
    let home = tmp.path().join("home");
    let before = fsutil::tree(&[host.root.as_path(), home.as_path()]);
    let v1 = tmp.path().join("v1");
    plugin(&v1, "demo", "1.0.0", json!({}));
    write(&v1.join("note.txt"), "v1\n");
    install::install(
        &host,
        &quiet_tools(),
        &local_source(&v1),
        RequestedBy::person(),
    )
    .unwrap();
    registry::enable(&host, "demo", &Scope::Global).unwrap();
    let lock_v1 = std::fs::read_to_string(host.root.join("lock.json")).unwrap();
    assert!(host.agents_skills.join("alpha").exists());

    let _reset = ResetFail;
    install::FAIL_AFTER_SWAP.with(|flag| flag.set(true));
    let v2 = tmp.path().join("v2");
    plugin(&v2, "demo", "2.0.0", json!({}));
    write(&v2.join("note.txt"), "v2\n");
    let err = install::update(
        &host,
        &quiet_tools(),
        "demo",
        &local_source(&v2),
        RequestedBy::person(),
    )
    .unwrap_err();
    assert!(err.contains("put back"), "{err}");
    assert_eq!(note(&host, "demo"), "v1\n");
    assert_eq!(installed_version(&host, "demo").as_deref(), Some("1.0.0"));
    assert_eq!(
        std::fs::read_to_string(host.root.join("lock.json")).unwrap(),
        lock_v1
    );
    assert!(host.agents_skills.join("alpha").exists());
    assert!(!host.trash().exists());
    assert!(!host.pending().exists());
    assert!(!host.previous("demo").exists());
    drop(_reset);

    install::update(
        &host,
        &quiet_tools(),
        "demo",
        &local_source(&v2),
        RequestedBy::person(),
    )
    .unwrap();
    assert_eq!(note(&host, "demo"), "v2\n");
    assert_eq!(
        std::fs::read_to_string(host.previous("demo").join("note.txt")).unwrap(),
        "v1\n"
    );
    assert!(registry::read(&host).unwrap().plugins["demo"]
        .previous
        .is_some());

    install::rollback(&host, "demo").unwrap();
    assert_eq!(note(&host, "demo"), "v1\n");
    assert_eq!(installed_version(&host, "demo").as_deref(), Some("1.0.0"));
    assert!(registry::read(&host).unwrap().plugins["demo"]
        .previous
        .is_none());
    assert!(!host.previous("demo").exists());
    assert!(host.agents_skills.join("alpha").exists());
    let again = install::rollback(&host, "demo").unwrap_err();
    assert!(again.contains("no earlier version"), "{again}");

    registry::uninstall(&host, "demo").unwrap();
    assert!(!host.root.join("lock.json").exists());
    assert!(!host.root.join("registry.json").exists());
    assert_eq!(fsutil::tree(&[host.root.as_path(), home.as_path()]), before);
    let rows = activity_rows(&tmp);
    let kinds: Vec<_> = rows.iter().map(|row| row.kind.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            crate::activity::PLUGIN_REMOVE,
            crate::activity::PLUGIN_ROLLBACK,
            crate::activity::PLUGIN_UPDATE,
            crate::activity::PLUGIN_INSTALL,
        ],
        "{rows:?}"
    );
    assert!(rows
        .iter()
        .all(|row| row.actor == crate::activity::Who::app()));
    assert!(rows
        .iter()
        .all(|row| row.initiator == crate::activity::Who::person()));
    assert_eq!(rows[3].summary, "Installed demo.");
    assert_eq!(rows[2].summary, "Updated demo.");
    assert_eq!(rows[1].summary, "Rolled demo back.");
    assert_eq!(rows[0].summary, "Removed demo.");
}

#[test]
fn a_script_waits_for_approval_and_nothing_runs_before_it() {
    let tmp = Tmp::new("script");
    let host = host(&tmp);
    let dir = tmp.path().join("src");
    plugin(
        &dir,
        "demo",
        "1.0.0",
        json!({
            "extensions": {
                "hivra": {
                    "setup": [{ "run": ["./mark"], "cwd": ".", "why": "It writes that it ran." }]
                }
            }
        }),
    );
    let result = install::install(
        &host,
        &quiet_tools(),
        &local_source(&dir),
        RequestedBy::person(),
    )
    .unwrap();
    let InstallResult::Waiting { request } = result else {
        panic!("a script must wait");
    };
    assert_eq!(request.steps[0].run, vec!["./mark".to_string()]);
    assert!(!host.installed("demo").exists());
    assert!(!host.installed("demo").join("ran.txt").exists());
    assert_eq!(install::pending(&host).len(), 1);
    assert!(!host.root.join("lock.json").exists());
}

#[test]
fn npm_install_is_shown_and_not_run_until_the_person_says_yes() {
    let tmp = Tmp::new("npm-step");
    let host = host(&tmp);
    let dir = tmp.path().join("src");
    plugin(&dir, "demo", "1.0.0", json!({}));
    write(
        &dir.join("package.json"),
        &json!({ "dependencies": { "left-pad": "1.3.0" } }).to_string(),
    );
    let result = install::install(
        &host,
        &quiet_tools(),
        &local_source(&dir),
        RequestedBy::person(),
    )
    .unwrap();
    let InstallResult::Waiting { request } = result else {
        panic!("npm install must wait");
    };
    assert_eq!(
        request.steps[0].run,
        vec!["npm", "install", "--omit=dev", "--no-audit", "--no-fund"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
    );
    assert!(!host.installed("demo").exists());
}

#[test]
fn a_shell_line_is_refused_and_nothing_is_left_waiting() {
    let tmp = Tmp::new("shell");
    let host = host(&tmp);
    let dir = tmp.path().join("src");
    for run in [json!(["bash -c echo hi"]), json!(["../bin/setup"])] {
        plugin(
            &dir,
            "demo",
            "1.0.0",
            json!({ "extensions": { "hivra": { "setup": [{ "run": run, "cwd": "." }] } } }),
        );
        let err = install::install(
            &host,
            &quiet_tools(),
            &local_source(&dir),
            RequestedBy::person(),
        )
        .unwrap_err();
        assert!(err.contains("never a shell line"), "{err}");
        assert!(install::pending(&host).is_empty());
        assert!(!host.pending().exists());
    }
}

#[cfg(unix)]
#[test]
fn an_approved_script_runs_inside_the_plugin_and_sees_no_secrets() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = Tmp::new("approve");
    let host = host(&tmp);
    let dir = tmp.path().join("src");
    plugin(
        &dir,
        "demo",
        "1.0.0",
        json!({
            "extensions": {
                "hivra": { "setup": [{ "run": ["./mark"], "cwd": ".", "why": "It writes that it ran." }] }
            }
        }),
    );
    let mark = dir.join("mark");
    write(&mark, "#!/bin/sh\nenv > \"$PLUGIN_ROOT/env.txt\"\n");
    std::fs::set_permissions(&mark, std::fs::Permissions::from_mode(0o755)).unwrap();
    let InstallResult::Waiting { request } = install::install(
        &host,
        &quiet_tools(),
        &local_source(&dir),
        RequestedBy::person(),
    )
    .unwrap() else {
        panic!("the script must wait");
    };
    assert!(
        !dir.join("env.txt").exists(),
        "the script ran before approval"
    );
    install::approve(&host, &quiet_tools(), &request.id).unwrap();
    let env = std::fs::read_to_string(host.installed("demo").join("env.txt")).unwrap();
    assert!(env.contains("PLUGIN_ROOT="), "{env}");
    assert!(!env.contains("ANTHROPIC_AUTH_TOKEN="), "{env}");
    assert!(
        !env.lines().any(|line| line.starts_with("MONOCODE_")),
        "{env}"
    );
    assert!(host.root.join("lock.json").exists());
}

#[test]
fn an_agents_install_waits_and_declining_leaves_nothing() {
    let tmp = Tmp::new("agent");
    let host = host(&tmp);
    let dir = tmp.path().join("src");
    plugin(&dir, "demo", "1.2.3", json!({}));
    let by = RequestedBy {
        kind: "agent".into(),
        reason: Some("It would help with reviews.".into()),
        ..RequestedBy::default()
    };
    let result = install::install(&host, &quiet_tools(), &local_source(&dir), by).unwrap();
    let InstallResult::Waiting { request } = result else {
        panic!("an agent's install must wait");
    };
    assert_eq!(request.requested_by.kind, "agent");
    assert_eq!(
        request.requested_by.reason.as_deref(),
        Some("It would help with reviews.")
    );
    assert_eq!(install::pending(&host).len(), 1);
    assert!(!host.installed("demo").exists());
    assert!(!host.root.join("lock.json").exists());

    install::decline(&host, &request.id).unwrap();
    assert!(install::pending(&host).is_empty());
    assert!(!host.pending().exists());
    assert!(!host.installed("demo").exists());
    let again = install::decline(&host, &request.id).unwrap_err();
    assert!(again.contains("isn't waiting"), "{again}");

    let unknown = RequestedBy {
        kind: String::new(),
        ..RequestedBy::default()
    };
    let result = install::install(&host, &quiet_tools(), &local_source(&dir), unknown).unwrap();
    assert!(matches!(result, InstallResult::Waiting { .. }));
    assert!(!host.installed("demo").exists());
}

#[test]
fn an_approved_agent_install_names_the_mono_and_drops_the_reason() {
    let tmp = Tmp::new("activity-agent");
    let host = host(&tmp);
    ready_activity(&tmp);
    let dir = tmp.path().join("src");
    plugin(&dir, "demo", "1.2.3", json!({}));
    let planted = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";
    let by = RequestedBy {
        kind: "agent".into(),
        session: Some("lead-1".into()),
        mono: Some("mono-9".into()),
        reason: Some(format!("It would help. {planted}")),
    };
    let result = install::install(&host, &quiet_tools(), &local_source(&dir), by).unwrap();
    let InstallResult::Waiting { request } = result else {
        panic!("an agent's install must wait");
    };
    assert!(activity_rows(&tmp).is_empty(), "waiting is not an install");
    install::approve(&host, &quiet_tools(), &request.id).unwrap();
    let again = install::approve(&host, &quiet_tools(), &request.id).unwrap_err();
    assert!(again.contains("isn't waiting"), "{again}");
    let rows = activity_rows(&tmp);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].kind, crate::activity::PLUGIN_INSTALL);
    assert_eq!(rows[0].actor, crate::activity::Who::app());
    assert_eq!(rows[0].initiator, crate::activity::Who::mono("mono-9", ""));
    assert_eq!(rows[0].summary, "Installed demo.");
    assert!(!format!("{:?}", rows[0]).contains(planted));
    assert!(!format!("{:?}", rows[0]).contains("lead-1"));
}

#[test]
fn installing_the_same_plugin_twice_keeps_the_first() {
    let tmp = Tmp::new("twice");
    let host = host(&tmp);
    let dir = tmp.path().join("src");
    plugin(&dir, "demo", "1.0.0", json!({}));
    install::install(
        &host,
        &quiet_tools(),
        &local_source(&dir),
        RequestedBy::person(),
    )
    .unwrap();
    let lock = std::fs::read_to_string(host.root.join("lock.json")).unwrap();
    let err = install::install(
        &host,
        &quiet_tools(),
        &local_source(&dir),
        RequestedBy::person(),
    )
    .unwrap_err();
    assert!(err.contains("already installed"), "{err}");
    assert_eq!(
        std::fs::read_to_string(host.root.join("lock.json")).unwrap(),
        lock
    );
    assert_eq!(installed_version(&host, "demo").as_deref(), Some("1.0.0"));
    let missing = install::update(
        &host,
        &quiet_tools(),
        "other",
        &local_source(&dir),
        RequestedBy::person(),
    )
    .unwrap_err();
    assert!(missing.contains("isn't installed"), "{missing}");
}

#[test]
fn a_crlf_manifest_in_a_folder_still_installs() {
    let tmp = Tmp::new("crlf");
    let host = host(&tmp);
    let dir = tmp.path().join("src");
    let text = json!({
        "$schema": PLUGIN_SCHEMA_1_0_0,
        "name": "demo",
        "version": "1.0.0",
    })
    .to_string()
    .replace('\n', "\r\n");
    write(&dir.join("plugin.json"), &text);
    install::install(
        &host,
        &quiet_tools(),
        &local_source(&dir),
        RequestedBy::person(),
    )
    .unwrap();
    assert_eq!(installed_version(&host, "demo").as_deref(), Some("1.0.0"));
}

#[test]
fn a_skill_that_stops_passing_is_unlinked_for_codex() {
    let tmp = Tmp::new("unlink");
    let host = host(&tmp);
    let dir = tmp.path().join("src");
    plugin(&dir, "demo", "1.0.0", json!({}));
    install::install(
        &host,
        &quiet_tools(),
        &local_source(&dir),
        RequestedBy::person(),
    )
    .unwrap();
    registry::enable(&host, "demo", &Scope::Global).unwrap();
    assert!(host.agents_skills.join("alpha").exists());
    write(
        &host.installed("demo").join("skills/alpha/SKILL.md"),
        "---\nname: alpha\ndescription: First.\nhooks: {}\n---\n\n# alpha\n",
    );
    let wiring =
        wiring::session_wiring(&host, None, Some("/app/monocode"), &Default::default()).unwrap();
    assert!(
        wiring
            .reports
            .iter()
            .any(|report| report.message.contains("alpha")),
        "{:?}",
        wiring.reports
    );
    assert!(!host.agents_skills.join("alpha").exists());
    let entry = registry::read(&host)
        .unwrap()
        .plugins
        .remove("demo")
        .unwrap();
    assert!(!entry
        .contributions
        .iter()
        .any(|c| matches!(c, Contribution::SkillLink { skill, .. } if skill == "alpha")));
    let again =
        wiring::session_wiring(&host, None, Some("/app/monocode"), &Default::default()).unwrap();
    assert!(!host.agents_skills.join("alpha").exists());
    assert!(again.claude_plugin_dirs.is_empty());
}
