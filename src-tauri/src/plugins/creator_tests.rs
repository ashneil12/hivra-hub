//! WP-34. Each contribution is drafted, previewed, kept, undone and discarded without a live model, and nothing
//! outside the scratch folder and the plugin host is written. A late result is checked again before it is recorded.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use super::compat::Target;
use super::creator::{self, DraftFile};
use super::fsutil;
use super::install::{self, InstallResult};
use super::manifest::{load_plugin, PLUGIN_SCHEMA_1_0_0};
use super::mcp::MCP_SCHEMA_1_0_0;
use super::registry::{self, Host};
use super::source::Tools;

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("hivra-wp34-{label}-{}", uuid::Uuid::new_v4()));
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

fn put(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, text).unwrap();
}

/// Programs that must not be started. A keep that needs no download never runs them.
fn quiet_tools() -> Tools {
    Tools {
        git: OsString::from("git-must-not-run"),
        npm: OsString::from("npm-must-not-run"),
        path: None,
        target: Target::here(),
    }
}

struct World {
    tmp: Tmp,
    sentinel: Vec<u8>,
    app: Vec<u8>,
}

impl World {
    fn new(label: &str) -> Self {
        let tmp = Tmp::new(label);
        let sentinel = b"outside-sentinel".to_vec();
        let app = b"export const App = 1;\n".to_vec();
        std::fs::write(tmp.path().join("sentinel"), &sentinel).unwrap();
        put(
            &tmp.path().join("src/app/App.tsx"),
            std::str::from_utf8(&app).unwrap(),
        );
        Self { tmp, sentinel, app }
    }

    fn host(&self) -> Host {
        let root = self.tmp.path().join("plugins");
        std::fs::create_dir_all(&root).unwrap();
        Host {
            root: root.clone(),
            agents_skills: root.join("agents-skills"),
        }
    }

    fn untouched(&self) {
        assert_eq!(
            std::fs::read(self.tmp.path().join("sentinel")).unwrap(),
            self.sentinel,
            "a file outside the plugin host changed"
        );
        assert_eq!(
            std::fs::read(self.tmp.path().join("src/app/App.tsx")).unwrap(),
            self.app,
            "Hivra's own code changed"
        );
    }
}

fn manifest(name: &str) -> String {
    json!({
        "$schema": PLUGIN_SCHEMA_1_0_0,
        "name": name,
        "version": "1.0.0",
    })
    .to_string()
}

fn files(pairs: &[(&str, &str)]) -> Vec<DraftFile> {
    pairs
        .iter()
        .map(|(path, content)| DraftFile {
            path: (*path).to_string(),
            content: (*content).to_string(),
        })
        .collect()
}

fn scratch(host: &Host, id: &str) -> PathBuf {
    host.root.join("creator").join(id).join("scratch")
}

fn no_skips(root: &Path) {
    let loaded = load_plugin(root).unwrap();
    assert!(
        loaded
            .reports
            .iter()
            .all(|report| !report.message.contains("Skipped")),
        "{:?}",
        loaded.reports
    );
}

struct Kind {
    expect: &'static str,
    name: &'static str,
    files: Vec<DraftFile>,
}

fn kinds() -> Vec<Kind> {
    vec![
        Kind {
            expect: "skill",
            name: "made-skill",
            files: files(&[
                ("plugin.json", &manifest("made-skill")),
                (
                    "skills/greet/SKILL.md",
                    "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
                ),
                ("notes/my note.txt", "hello\r\nthere"),
                ("notes/héllo.txt", "héllo\r\n"),
            ]),
        },
        Kind {
            expect: "panel",
            name: "made-panel",
            files: files(&[
                ("plugin.json", &manifest("made-panel")),
                (
                    "hivra/panels/hello/panel.json",
                    r#"{"kind":"bespoke","title":"Hello","permissions":[]}"#,
                ),
                ("hivra/panels/hello/index.html", "<p>Hello</p>"),
            ]),
        },
        Kind {
            expect: "persona",
            name: "made-persona",
            files: files(&[
                ("plugin.json", &manifest("made-persona")),
                (
                    "hivra/personas/critic.md",
                    "---\nname: critic\ndescription: A critic.\n---\n\nBe sharp.\n",
                ),
            ]),
        },
        Kind {
            expect: "mono",
            name: "made-mono",
            files: files(&[
                ("plugin.json", &manifest("made-mono")),
                (
                    "hivra/monos/helper/mono.json",
                    r#"{"name":"Helper","role":"Helps."}"#,
                ),
                ("hivra/monos/helper/SOUL.md", "# Soul\n\nHelps.\n"),
            ]),
        },
        Kind {
            expect: "command",
            name: "made-command",
            files: files(&[
                ("plugin.json", &manifest("made-command")),
                ("hivra/commands/greet.md", "Say hello.\n"),
            ]),
        },
    ]
}

fn entry(host: &Host, name: &str) -> registry::Entry {
    registry::read(host)
        .unwrap()
        .plugins
        .get(name)
        .unwrap()
        .clone()
}

#[test]
fn the_creator_template_loads() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/features/creator/template");
    let loaded = load_plugin(&root).unwrap();
    assert!(
        loaded
            .reports
            .iter()
            .all(|report| !report.message.contains("Skipped")),
        "{:?}",
        loaded.reports
    );
    assert_eq!(loaded.skills.len(), 5);
    let mono = loaded
        .hivra
        .monos
        .iter()
        .find(|mono| mono.id == "creator")
        .unwrap();
    assert_eq!(mono.name, "Creator");
    let soul = std::fs::read_to_string(root.join("hivra/monos/creator/SOUL.md")).unwrap();
    assert!(soul.contains("dev copy"), "{soul}");
    for skill in [
        "write-skill",
        "write-panel",
        "write-persona",
        "write-mono",
        "write-command",
    ] {
        let text = std::fs::read_to_string(root.join(format!("skills/{skill}/SKILL.md"))).unwrap();
        assert!(text.contains("tools/list"), "{skill}");
        assert!(text.contains("scratch"), "{skill}");
    }
    let panel = std::fs::read_to_string(root.join("skills/write-panel/SKILL.md")).unwrap();
    assert!(panel.contains("sandbox"), "{panel}");
}

#[test]
fn each_kind_is_created_previewed_kept_undone_and_discarded() {
    let world = World::new("kinds");
    let host = world.host();
    let tools = quiet_tools();
    for kind in kinds() {
        let started = creator::start(&host, "this-view", kind.expect).unwrap();
        let drafted = creator::draft(&host, &started.id, started.revision, &kind.files).unwrap();
        assert_eq!(drafted.phase, "drafted");
        assert_eq!(drafted.plugin.as_deref(), Some(kind.name));
        let folder = scratch(&host, &drafted.id);
        no_skips(&folder);
        let loaded = load_plugin(&folder).unwrap();
        match kind.expect {
            "skill" => assert!(!loaded.skills.is_empty()),
            "panel" => {
                assert!(!loaded.hivra.panels.is_empty());
                assert!(drafted.panel.unwrap().html.contains("<p>"));
            }
            "persona" => assert!(!loaded.hivra.personas.is_empty()),
            "mono" => assert!(!loaded.hivra.monos.is_empty()),
            "command" => assert!(!loaded.hivra.commands.is_empty()),
            _ => unreachable!(),
        }
        if kind.expect == "skill" {
            assert_eq!(
                std::fs::read(folder.join("notes/my note.txt")).unwrap(),
                b"hello\r\nthere"
            );
            assert_eq!(
                std::fs::read(folder.join("notes/héllo.txt")).unwrap(),
                "héllo\r\n".as_bytes()
            );
        }

        let previewed = creator::preview(&host, &drafted.id, drafted.revision).unwrap();
        assert_eq!(previewed.phase, "previewed");
        assert!(!previewed.enabled_globally);
        assert!(previewed.visible_here);
        let installed = entry(&host, kind.name);
        assert!(!installed.enabled.global);
        assert!(installed.enabled.projects.is_empty());
        assert!(!installed.active_for(None));
        assert!(creator::visible(&host, "this-view", kind.name));
        assert!(!creator::visible(&host, "other-view", kind.name));
        assert!(!host.agents_skills.join("greet").exists());
        let again = creator::preview(&host, &previewed.id, previewed.revision).unwrap();
        assert_eq!(again.revision, previewed.revision);
        let too_soon = creator::undo(&host, &previewed.id, previewed.revision).unwrap_err();
        assert!(too_soon.contains("nothing to undo"), "{too_soon}");

        let kept = creator::keep(&host, &tools, &previewed.id, previewed.revision).unwrap();
        assert_eq!(kept.phase, "kept");
        assert!(kept.enabled_globally);
        assert!(entry(&host, kind.name).enabled.global);
        assert!(entry(&host, kind.name).active_for(None));
        if kind.expect == "skill" {
            let link = host.agents_skills.join("greet");
            let target = fsutil::canonical(&fsutil::link_target(&link).unwrap()).unwrap();
            let installed = fsutil::canonical(&host.installed(kind.name)).unwrap();
            assert!(
                target.starts_with(&installed),
                "{target:?} is not inside {installed:?}"
            );
        }
        let kept_again = creator::keep(&host, &tools, &kept.id, kept.revision).unwrap();
        assert_eq!(kept_again.revision, kept.revision);

        let undone = creator::undo(&host, &kept.id, kept.revision).unwrap();
        assert_eq!(undone.phase, "undone");
        assert!(!undone.enabled_globally);
        assert!(!entry(&host, kind.name).enabled.global);
        assert!(!host.agents_skills.join("greet").exists());
        assert!(creator::visible(&host, "this-view", kind.name));
        assert!(!creator::visible(&host, "other-view", kind.name));

        let discarded = creator::discard(&host, &undone.id, undone.revision).unwrap();
        assert_eq!(discarded.phase, "discarded");
        assert!(!folder.exists());
        assert!(host.installed(kind.name).join("plugin.json").is_file());
        let twice = creator::discard(&host, &discarded.id, discarded.revision).unwrap_err();
        assert!(twice.contains("already gone"), "{twice}");
        world.untouched();
    }
}

#[test]
fn a_draft_cannot_leave_the_scratch_folder() {
    let world = World::new("escape");
    let host = world.host();
    let started = creator::start(&host, "this-view", "skill").unwrap();
    let good = files(&[
        ("plugin.json", &manifest("made-skill")),
        (
            "skills/greet/SKILL.md",
            "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
        ),
    ]);
    let drafted = creator::draft(&host, &started.id, started.revision, &good).unwrap();
    let folder = scratch(&host, &drafted.id);
    let before = std::fs::read(folder.join("plugin.json")).unwrap();
    let sentinel = world.tmp.path().join("sentinel");
    let escapes = [
        "../../../../src/app/App.tsx".to_string(),
        sentinel.to_string_lossy().into_owned(),
        r"..\..\sentinel".to_string(),
        "hivra/../../sentinel".to_string(),
    ];
    for path in escapes {
        let mut mixed = good.clone();
        mixed.push(DraftFile {
            path,
            content: "pwned".into(),
        });
        let err = creator::draft(&host, &drafted.id, drafted.revision, &mixed).unwrap_err();
        assert!(err.contains("isn't inside"), "{err}");
        assert_eq!(std::fs::read(folder.join("plugin.json")).unwrap(), before);
        world.untouched();
    }
}

#[test]
fn empty_duplicate_and_stale_drafts_do_not_write() {
    let world = World::new("empty");
    let host = world.host();
    let started = creator::start(&host, "this-view", "skill").unwrap();
    let folder = scratch(&host, &started.id);
    let empty = creator::draft(&host, &started.id, started.revision, &[]).unwrap_err();
    assert!(empty.contains("nothing to write"), "{empty}");
    assert!(!folder.exists());
    let stale =
        creator::draft(&host, &started.id, 0, &files(&[("plugin.json", "{}")])).unwrap_err();
    assert!(stale.contains("out of date"), "{stale}");
    assert!(!folder.exists());
    let good = files(&[
        ("plugin.json", &manifest("made-skill")),
        (
            "skills/greet/SKILL.md",
            "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
        ),
    ]);
    let drafted = creator::draft(&host, &started.id, started.revision, &good).unwrap();
    let before = std::fs::read(folder.join("plugin.json")).unwrap();
    let mut twice = good.clone();
    twice.push(good[0].clone());
    let dup = creator::draft(&host, &drafted.id, drafted.revision, &twice).unwrap_err();
    assert!(dup.contains("twice"), "{dup}");
    assert_eq!(std::fs::read(folder.join("plugin.json")).unwrap(), before);
    world.untouched();
}

#[test]
fn a_broken_panel_is_refused_and_the_scratch_folder_is_not_created() {
    let world = World::new("broken");
    let host = world.host();
    let started = creator::start(&host, "this-view", "panel").unwrap();
    let err = creator::draft(
        &host,
        &started.id,
        started.revision,
        &files(&[
            ("plugin.json", &manifest("made-panel")),
            ("hivra/panels/hello/panel.json", "{}"),
        ]),
    )
    .unwrap_err();
    assert!(err.contains("no panel"), "{err}");
    assert!(!scratch(&host, &started.id).exists());
    assert!(!host
        .root
        .join("creator")
        .join(&started.id)
        .join("staging")
        .exists());
    world.untouched();
}

#[test]
fn discard_before_preview_installs_nothing() {
    let world = World::new("discard-first");
    let host = world.host();
    let started = creator::start(&host, "this-view", "skill").unwrap();
    let drafted = creator::draft(
        &host,
        &started.id,
        started.revision,
        &files(&[
            ("plugin.json", &manifest("made-skill")),
            (
                "skills/greet/SKILL.md",
                "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
            ),
        ]),
    )
    .unwrap();
    let discarded = creator::discard(&host, &drafted.id, drafted.revision).unwrap();
    let err = creator::preview(&host, &discarded.id, discarded.revision).unwrap_err();
    assert!(err.contains("gone"), "{err}");
    assert!(registry::read(&host).unwrap().plugins.is_empty());
    world.untouched();
}

#[test]
fn a_bad_view_or_kind_creates_nothing() {
    let world = World::new("view");
    let host = world.host();
    for (view, expect) in [
        ("", "skill"),
        ("view", "nope"),
        ("../x", "skill"),
        ("this view", "skill"),
        ("héllo", "skill"),
    ] {
        assert!(
            creator::start(&host, view, expect).is_err(),
            "{view} {expect}"
        );
    }
    assert!(creator::start(&host, &"a".repeat(65), "skill").is_err());
    assert!(!host.root.join("creator").exists());
    assert!(creator::start(&host, "this-view", "skill").is_ok());
    assert!(creator::start(&host, &"b".repeat(64), "skill").is_ok());
}

#[test]
fn a_session_file_with_an_extra_field_is_not_trusted() {
    let world = World::new("session");
    let host = world.host();
    let started = creator::start(&host, "this-view", "skill").unwrap();
    let path = host
        .root
        .join("creator")
        .join(&started.id)
        .join("session.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    value["extra"] = json!(true);
    std::fs::write(&path, value.to_string()).unwrap();
    let err = creator::load_state(&host, &started.id).unwrap_err();
    assert!(err.contains("can't be read"), "{err}");
}

#[test]
fn a_corrupt_view_list_is_not_rewritten_and_nothing_stays_installed() {
    let world = World::new("views");
    let host = world.host();
    let started = creator::start(&host, "this-view", "skill").unwrap();
    let drafted = creator::draft(
        &host,
        &started.id,
        started.revision,
        &files(&[
            ("plugin.json", &manifest("made-skill")),
            (
                "skills/greet/SKILL.md",
                "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
            ),
        ]),
    )
    .unwrap();
    let views = host.root.join("creator").join("views.json");
    std::fs::write(&views, "nope").unwrap();
    let bytes = std::fs::read(&views).unwrap();
    let err = creator::preview(&host, &drafted.id, drafted.revision).unwrap_err();
    assert!(err.contains("view list"), "{err}");
    assert_eq!(std::fs::read(&views).unwrap(), bytes);
    assert!(registry::read(&host).unwrap().plugins.is_empty());
    let state = creator::load_state(&host, &drafted.id).unwrap();
    assert_eq!(state.phase, "drafted");
    world.untouched();
}

#[test]
fn two_views_each_see_only_their_own_preview() {
    let world = World::new("two-views");
    let host = world.host();
    let skill = |name: &str| {
        files(&[
            ("plugin.json", &manifest(name)),
            (
                "skills/greet/SKILL.md",
                "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
            ),
        ])
    };
    let left = creator::start(&host, "view-a", "skill").unwrap();
    let left = creator::draft(&host, &left.id, left.revision, &skill("made-a")).unwrap();
    let right = creator::start(&host, "view-b", "skill").unwrap();
    let right = creator::draft(&host, &right.id, right.revision, &skill("made-b")).unwrap();
    let host_a = host.clone();
    let host_b = host.clone();
    let left_id = left.id.clone();
    let right_id = right.id.clone();
    std::thread::scope(|scope| {
        scope.spawn(|| creator::preview(&host_a, &left_id, left.revision).unwrap());
        scope.spawn(|| creator::preview(&host_b, &right_id, right.revision).unwrap());
    });
    assert!(creator::visible(&host, "view-a", "made-a"));
    assert!(!creator::visible(&host, "view-b", "made-a"));
    assert!(creator::visible(&host, "view-b", "made-b"));
    assert!(!creator::visible(&host, "view-a", "made-b"));
    assert!(!entry(&host, "made-a").enabled.global);
    assert!(!entry(&host, "made-b").enabled.global);
    world.untouched();
}

struct Clear(String);

impl Drop for Clear {
    fn drop(&mut self) {
        creator::testing_before_commit(&self.0, None);
    }
}

fn skill_draft(host: &Host, name: &str) -> creator::CreatorState {
    let started = creator::start(host, "this-view", "skill").unwrap();
    creator::draft(
        host,
        &started.id,
        started.revision,
        &files(&[
            ("plugin.json", &manifest(name)),
            (
                "skills/greet/SKILL.md",
                "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
            ),
        ]),
    )
    .unwrap()
}

#[test]
fn a_preview_discarded_while_it_installs_is_taken_back() {
    let world = World::new("late-preview");
    let host = world.host();
    let drafted = skill_draft(&host, "made-skill");
    let host_hook = host.clone();
    let id = drafted.id.clone();
    let hook_id = id.clone();
    creator::testing_before_commit(
        &id,
        Some(Box::new(move || {
            let current = creator::load_state(&host_hook, &hook_id).unwrap();
            creator::discard(&host_hook, &hook_id, current.revision).unwrap();
        })),
    );
    let _clear = Clear(drafted.id.clone());
    let err = creator::preview(&host, &drafted.id, drafted.revision).unwrap_err();
    assert!(err.contains("gone"), "{err}");
    assert!(registry::read(&host).unwrap().plugins.is_empty());
    world.untouched();
}

#[test]
fn a_keep_discarded_while_it_updates_is_not_enabled() {
    let world = World::new("late-keep");
    let host = world.host();
    let tools = quiet_tools();
    let drafted = skill_draft(&host, "made-skill");
    let previewed = creator::preview(&host, &drafted.id, drafted.revision).unwrap();
    let host_hook = host.clone();
    let id = previewed.id.clone();
    let hook_id = id.clone();
    creator::testing_before_commit(
        &id,
        Some(Box::new(move || {
            let current = creator::load_state(&host_hook, &hook_id).unwrap();
            creator::discard(&host_hook, &hook_id, current.revision).unwrap();
        })),
    );
    let _clear = Clear(previewed.id.clone());
    let err = creator::keep(&host, &tools, &previewed.id, previewed.revision).unwrap_err();
    assert!(err.contains("gone"), "{err}");
    assert!(!entry(&host, "made-skill").enabled.global);
    world.untouched();
}

#[test]
fn a_setup_step_waits_and_a_decline_does_not_enable_it() {
    let world = World::new("setup");
    let host = world.host();
    let tools = quiet_tools();
    let sentinel = world.tmp.path().join("sentinel");
    let plugin = json!({
        "$schema": PLUGIN_SCHEMA_1_0_0,
        "name": "made-skill",
        "version": "1.0.0",
        "extensions": {
            "hivra": {
                "setup": [{
                    "run": ["touch", sentinel.to_string_lossy()],
                    "cwd": ".",
                    "why": "It would write outside the plugin."
                }]
            }
        }
    })
    .to_string();
    let started = creator::start(&host, "this-view", "skill").unwrap();
    let drafted = creator::draft(
        &host,
        &started.id,
        started.revision,
        &files(&[
            ("plugin.json", &plugin),
            (
                "skills/greet/SKILL.md",
                "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
            ),
        ]),
    )
    .unwrap();
    let previewed = creator::preview(&host, &drafted.id, drafted.revision).unwrap();
    let waiting = creator::keep(&host, &tools, &previewed.id, previewed.revision).unwrap();
    assert!(waiting.script_waiting, "{waiting:?}");
    assert_eq!(waiting.phase, "previewed");
    assert!(!waiting.enabled_globally);
    world.untouched();
    let pending = install::pending(&host);
    assert_eq!(pending.len(), 1);
    install::decline(&host, &pending[0].id).unwrap();
    let err = creator::keep(&host, &tools, &waiting.id, waiting.revision).unwrap_err();
    assert!(err.contains("declined"), "{err}");
    assert!(!entry(&host, "made-skill").enabled.global);
    world.untouched();
}

#[cfg(unix)]
#[test]
fn an_approved_setup_runs_inside_the_plugin() {
    use std::os::unix::fs::PermissionsExt;
    let world = World::new("approve");
    let host = world.host();
    let tools = quiet_tools();
    let plugin = json!({
        "$schema": PLUGIN_SCHEMA_1_0_0,
        "name": "made-skill",
        "version": "1.0.0",
        "extensions": {
            "hivra": {
                "setup": [{ "run": ["./stay.sh"], "cwd": ".", "why": "It writes that it ran." }]
            }
        }
    })
    .to_string();
    let started = creator::start(&host, "this-view", "skill").unwrap();
    let drafted = creator::draft(
        &host,
        &started.id,
        started.revision,
        &files(&[
            ("plugin.json", &plugin),
            (
                "skills/greet/SKILL.md",
                "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
            ),
            ("stay.sh", "#!/bin/sh\ntouch ran.txt\n"),
        ]),
    )
    .unwrap();
    let script = scratch(&host, &drafted.id).join("stay.sh");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let previewed = creator::preview(&host, &drafted.id, drafted.revision).unwrap();
    let waiting = creator::keep(&host, &tools, &previewed.id, previewed.revision).unwrap();
    assert!(waiting.script_waiting);
    world.untouched();
    let pending = install::pending(&host);
    let InstallResult::Installed { .. } = install::approve(&host, &tools, &pending[0].id).unwrap()
    else {
        panic!("approving the setup step should install it");
    };
    let kept = creator::keep(&host, &tools, &waiting.id, waiting.revision).unwrap();
    assert_eq!(kept.phase, "kept");
    assert!(kept.enabled_globally);
    assert!(host.installed("made-skill").join("ran.txt").is_file());
    world.untouched();
}

#[cfg(windows)]
#[test]
fn an_approved_setup_runs_inside_the_plugin() {
    // The Unix test runs `./stay.sh`. Windows has no shell script to approve here.
}

#[cfg(unix)]
#[test]
fn a_symlink_scratch_folder_is_refused_and_discard_removes_only_the_link() {
    let world = World::new("link");
    let host = world.host();
    let started = creator::start(&host, "this-view", "skill").unwrap();
    let outside = world.tmp.path().join("link-target");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("keep.txt"), "keep").unwrap();
    let folder = scratch(&host, &started.id);
    std::os::unix::fs::symlink(&outside, &folder).unwrap();
    let err = creator::draft(
        &host,
        &started.id,
        started.revision,
        &files(&[
            ("plugin.json", &manifest("made-skill")),
            (
                "skills/greet/SKILL.md",
                "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
            ),
        ]),
    )
    .unwrap_err();
    assert!(err.contains("real folder"), "{err}");
    assert_eq!(std::fs::read(outside.join("keep.txt")).unwrap(), b"keep");
    creator::discard(&host, &started.id, started.revision).unwrap();
    assert!(!folder.exists());
    assert_eq!(std::fs::read(outside.join("keep.txt")).unwrap(), b"keep");
    world.untouched();
}

#[cfg(windows)]
#[test]
fn a_symlink_scratch_folder_is_refused_and_discard_removes_only_the_link() {
    // Creating a junction needs extra rights. The Unix test covers the link.
}

fn mcp_plugin(name: &str, command: &str) -> String {
    let _ = name;
    json!({
        "$schema": MCP_SCHEMA_1_0_0,
        "mcpServers": { "ping": { "type": "stdio", "command": command } }
    })
    .to_string()
}

fn draft_mcp(
    host: &Host,
    name: &str,
    command: &str,
    server: Option<&str>,
) -> creator::CreatorState {
    let started = creator::start(host, "this-view", "skill").unwrap();
    let mut pairs = vec![
        ("plugin.json".to_string(), manifest(name)),
        (
            "skills/greet/SKILL.md".to_string(),
            "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n".to_string(),
        ),
        ("mcp.json".to_string(), mcp_plugin(name, command)),
    ];
    if let Some(server) = server {
        pairs.push(("server.py".to_string(), server.to_string()));
    }
    let files = pairs
        .iter()
        .map(|(path, content)| DraftFile {
            path: path.clone(),
            content: content.clone(),
        })
        .collect::<Vec<_>>();
    creator::draft(host, &started.id, started.revision, &files).unwrap()
}

const ANSWERS: &str = r#"#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
here = Path(__file__).resolve().parent
(here / "started.txt").write_text("yes")
(here / "env.txt").write_text(
    "PLUGIN_ROOT=" + os.environ.get("PLUGIN_ROOT", "") + "\n"
    + "HAS_CARGO=" + ("1" if "CARGO_MANIFEST_DIR" in os.environ else "0") + "\n"
)

def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        if b":" in line:
            name, value = line.split(b":", 1)
            headers[name.decode().lower()] = value.decode().strip()
    length = int(headers.get("content-length", "0"))
    return json.loads(sys.stdin.buffer.read(length) or b"null")

def write_message(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(("Content-Length: %s\r\n\r\n" % len(body)).encode())
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

while True:
    msg = read_message()
    if not msg:
        break
    method = msg.get("method")
    if method == "initialize":
        write_message({"jsonrpc": "2.0", "id": msg.get("id"), "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "ping", "version": "0"}}})
    elif method == "tools/list":
        write_message({"jsonrpc": "2.0", "id": msg.get("id"), "result": {"tools": [{"name": "ping", "description": "secret-token"}]}})
        break
"#;

const SLEEPS: &str = r#"#!/usr/bin/env python3
from pathlib import Path
import time
Path(__file__).resolve().parent.joinpath("started.txt").write_text("yes")
time.sleep(30)
"#;

#[test]
fn an_mcp_server_does_not_run_until_the_person_allows_it() {
    let world = World::new("mcp-gate");
    let host = world.host();
    let tools = quiet_tools();
    let drafted = draft_mcp(&host, "made-skill", "./server.py", Some("print('no')\n"));
    let folder = scratch(&host, &drafted.id);
    let probed = creator::probe_mcp(
        &host,
        &drafted.id,
        drafted.revision,
        Duration::from_millis(1500),
    )
    .unwrap();
    assert!(!probed.mcp_approved);
    assert_eq!(probed.phase, "drafted");
    assert!(!folder.join("started.txt").exists());
    let previewed = creator::preview(&host, &probed.id, probed.revision).unwrap();
    let held = creator::keep(&host, &tools, &previewed.id, previewed.revision).unwrap();
    assert!(held.mcp_waiting);
    assert_eq!(held.phase, "previewed");
    assert!(!held.enabled_globally);
    assert!(!folder.join("started.txt").exists());
    world.untouched();
}

#[test]
fn a_bare_command_and_a_web_server_are_not_started() {
    let world = World::new("mcp-skip");
    let host = world.host();
    let bare = draft_mcp(
        &host,
        "made-bare",
        "python3",
        Some("raise SystemExit('ran')\n"),
    );
    let allowed = creator::approve_mcp(&host, &bare.id, bare.revision).unwrap();
    let probed = creator::probe_mcp(
        &host,
        &allowed.id,
        allowed.revision,
        Duration::from_millis(1500),
    )
    .unwrap();
    assert_eq!(probed.phase, "drafted");
    let note = probed.mcp_note.unwrap();
    assert!(note.contains("wasn't started"), "{note}");
    assert!(!scratch(&host, &probed.id).join("started.txt").exists());

    let started = creator::start(&host, "this-view", "skill").unwrap();
    let web = creator::draft(
        &host,
        &started.id,
        started.revision,
        &files(&[
            ("plugin.json", &manifest("made-web")),
            (
                "skills/greet/SKILL.md",
                "---\nname: greet\ndescription: Says hello.\n---\n\n# greet\n",
            ),
            (
                "mcp.json",
                &json!({
                    "$schema": MCP_SCHEMA_1_0_0,
                    "mcpServers": {
                        "web": { "type": "streamable-http", "url": "http://127.0.0.1:9" }
                    }
                })
                .to_string(),
            ),
        ]),
    )
    .unwrap();
    let allowed = creator::approve_mcp(&host, &web.id, web.revision).unwrap();
    let probed = creator::probe_mcp(
        &host,
        &allowed.id,
        allowed.revision,
        Duration::from_millis(500),
    )
    .unwrap();
    let note = probed.mcp_note.unwrap();
    assert!(note.contains("web server"), "{note}");
    assert_eq!(probed.phase, "drafted");
    world.untouched();
}

#[test]
fn a_missing_program_is_not_a_failed_draft() {
    let world = World::new("mcp-missing");
    let host = world.host();
    let drafted = draft_mcp(&host, "made-miss", "./missing.py", None);
    let allowed = creator::approve_mcp(&host, &drafted.id, drafted.revision).unwrap();
    let probed = creator::probe_mcp(
        &host,
        &allowed.id,
        allowed.revision,
        Duration::from_millis(1500),
    )
    .unwrap();
    let note = probed.mcp_note.unwrap();
    assert!(note.contains("didn't start"), "{note}");
    assert_eq!(probed.phase, "drafted");
    let previewed = creator::preview(&host, &probed.id, probed.revision).unwrap();
    assert_eq!(previewed.phase, "previewed");
    world.untouched();
}

#[cfg(unix)]
#[test]
fn a_probe_that_answers_tools_list_is_kept_and_a_timeout_is_not_failure() {
    use std::os::unix::fs::PermissionsExt;
    let world = World::new("mcp-probe");
    let host = world.host();
    let drafted = draft_mcp(&host, "made-probe", "./server.py", Some(ANSWERS));
    let script = scratch(&host, &drafted.id).join("server.py");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let allowed = creator::approve_mcp(&host, &drafted.id, drafted.revision).unwrap();
    let probed =
        creator::probe_mcp(&host, &allowed.id, allowed.revision, Duration::from_secs(5)).unwrap();
    assert_eq!(probed.mcp_tools, vec!["ping".to_string()]);
    assert!(probed.mcp_note.is_none());
    assert_eq!(probed.phase, "drafted");
    let folder = scratch(&host, &probed.id);
    let env = std::fs::read_to_string(folder.join("env.txt")).unwrap();
    assert!(env.contains("PLUGIN_ROOT="), "{env}");
    assert!(
        env.lines()
            .any(|line| line.starts_with("PLUGIN_ROOT=") && line.len() > "PLUGIN_ROOT=".len()),
        "{env}"
    );
    assert!(env.contains("HAS_CARGO=0"), "{env}");
    let session = std::fs::read_to_string(
        host.root
            .join("creator")
            .join(&probed.id)
            .join("session.json"),
    )
    .unwrap();
    assert!(!session.contains("secret-token"), "{session}");
    assert!(folder.join("probe-data").is_dir());
    assert!(!host.data("made-probe").exists());
    world.untouched();

    let slow = draft_mcp(&host, "made-slow", "./server.py", Some(SLEEPS));
    let script = scratch(&host, &slow.id).join("server.py");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let allowed = creator::approve_mcp(&host, &slow.id, slow.revision).unwrap();
    let probed = creator::probe_mcp(
        &host,
        &allowed.id,
        allowed.revision,
        Duration::from_millis(1500),
    )
    .unwrap();
    let note = probed.mcp_note.unwrap();
    assert!(note.contains("timed out"), "{note}");
    assert!(note.contains("wasn't marked as failed"), "{note}");
    assert_eq!(probed.phase, "drafted");
    assert!(scratch(&host, &probed.id).join("started.txt").is_file());
    let previewed = creator::preview(&host, &probed.id, probed.revision).unwrap();
    assert_eq!(previewed.phase, "previewed");
    world.untouched();
}

#[cfg(windows)]
#[test]
fn a_probe_that_answers_tools_list_is_kept_and_a_timeout_is_not_failure() {
    // The Unix test starts python3. This target has no equivalent interpreter in the fixture.
}

#[test]
fn frames_round_trip_and_a_huge_length_is_refused() {
    let body = br#"{"ok":true}"#;
    let raw = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut cursor = std::io::Cursor::new([raw.as_bytes(), body].concat());
    let value = creator::read_frame(&mut cursor).unwrap();
    assert_eq!(value["ok"], true);

    let mut missing = std::io::Cursor::new(&b"\r\n\r\n"[..]);
    assert!(creator::read_frame(&mut missing).is_err());

    let mut huge = std::io::Cursor::new(&b"Content-Length: 99999999\r\n\r\n"[..]);
    let err = creator::read_frame(&mut huge).unwrap_err();
    assert!(err.contains("too big"), "{err}");
}
