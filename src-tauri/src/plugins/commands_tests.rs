//! WP-182: a Mono's command list reads `hivra/commands/<name>.md` from plugins that are on for this folder.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::fsutil;
use super::hivra::Command;
use super::manifest::PLUGIN_SCHEMA_1_0_0;
use super::plugin_commands_for;
use super::registry::{Contribution, Enablement, Entry, Host, Registry, Source};

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("hivra-plugin-commands-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(fsutil::canonical(&dir).unwrap())
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

fn manifest(name: &str) -> String {
    format!(r#"{{"$schema":"{PLUGIN_SCHEMA_1_0_0}","name":"{name}","version":"1.0.0"}}"#)
}

fn command_file(root: &Path, name: &str, body: &str) {
    write(
        &root
            .join("hivra")
            .join("commands")
            .join(format!("{name}.md")),
        &format!("---\ndescription: {name} command\n---\n\n{body}\n"),
    );
}

fn entry(name: &str, enabled: Enablement) -> Entry {
    Entry {
        name: name.into(),
        version: Some("1.0.0".into()),
        source: Source::local(Path::new("plugin")),
        installed_at_ms: 1,
        enabled,
        contributions: vec![Contribution::Command {
            name: "not-a-file".into(),
        }],
        integrity: None,
        previous: None,
    }
}

fn save(host: &Host, plugins: Vec<Entry>) {
    let mut map = BTreeMap::new();
    for plugin in plugins {
        map.insert(plugin.name.clone(), plugin);
    }
    let registry = Registry {
        version: 1,
        plugins: map,
        created_dirs: vec![],
    };
    std::fs::write(
        host.root.join("registry.json"),
        serde_json::to_string(&registry).unwrap(),
    )
    .unwrap();
}

fn host(tmp: &Tmp) -> Host {
    let host = Host {
        root: tmp.0.join("plugins"),
        agents_skills: tmp.0.join("skills"),
    };
    std::fs::create_dir_all(&host.root).unwrap();
    host
}

fn names(commands: &[Command]) -> Vec<&str> {
    commands
        .iter()
        .map(|command| command.name.as_str())
        .collect()
}

#[test]
fn lists_commands_from_plugins_enabled_for_the_folder() {
    let tmp = Tmp::new();
    let host = host(&tmp);
    let project = tmp.0.join("my work").join("héllo");
    std::fs::create_dir_all(&project).unwrap();

    let alpha = host.installed("alpha");
    write(&alpha.join("plugin.json"), &manifest("alpha"));
    command_file(&alpha, "ship", "Ship the change.");
    command_file(&alpha, "blank", "");
    write(
        &alpha.join("hivra").join("commands").join("notes.txt"),
        "not a command",
    );

    let beta = host.installed("beta");
    write(&beta.join("plugin.json"), &manifest("beta"));
    write(
        &beta.join("hivra").join("commands").join("ship.md"),
        "---\ndescription: from beta\n---\n\nBeta copy.\n",
    );
    command_file(&beta, "greet", "Hello.");

    let off = host.installed("off");
    write(&off.join("plugin.json"), &manifest("off"));
    command_file(&off, "hidden", "No.");

    let elsewhere = host.installed("elsewhere");
    write(&elsewhere.join("plugin.json"), &manifest("elsewhere"));
    command_file(&elsewhere, "other-project", "No.");

    let broken = host.installed("broken");
    std::fs::create_dir_all(&broken).unwrap();

    save(
        &host,
        vec![
            entry(
                "alpha",
                Enablement {
                    global: true,
                    projects: vec![],
                },
            ),
            entry(
                "beta",
                Enablement {
                    global: true,
                    projects: vec![],
                },
            ),
            entry("off", Enablement::default()),
            entry(
                "elsewhere",
                Enablement {
                    global: false,
                    projects: vec![tmp.0.join("other").to_string_lossy().into_owned()],
                },
            ),
            entry(
                "broken",
                Enablement {
                    global: true,
                    projects: vec![],
                },
            ),
            entry(
                "local-only",
                Enablement {
                    global: false,
                    projects: vec![project.to_string_lossy().into_owned()],
                },
            ),
        ],
    );
    let local_only = host.installed("local-only");
    write(&local_only.join("plugin.json"), &manifest("local-only"));
    command_file(&local_only, "local", "Here.");

    let listed = plugin_commands_for(&host, &project);
    assert_eq!(names(&listed), vec!["greet", "local", "ship"]);
    let ship = listed
        .iter()
        .find(|command| command.name == "ship")
        .unwrap();
    assert_eq!(ship.description, "ship command");
    assert!(names(&listed).iter().all(|name| *name != "not-a-file"));
    assert!(names(&listed).iter().all(|name| *name != "blank"));
    assert!(names(&listed).iter().all(|name| *name != "hidden"));
    assert!(names(&listed).iter().all(|name| *name != "other-project"));

    let relative = plugin_commands_for(&host, Path::new("relative"));
    assert!(names(&relative).contains(&"ship"));
    assert!(!names(&relative).contains(&"local"));

    std::fs::write(host.root.join("registry.json"), "not json").unwrap();
    assert!(plugin_commands_for(&host, &project).is_empty());

    std::fs::remove_file(host.root.join("registry.json")).unwrap();
    assert!(plugin_commands_for(&host, &project).is_empty());
}

#[cfg(unix)]
#[test]
fn skips_a_command_whose_file_leaves_the_plugin() {
    let tmp = Tmp::new();
    let host = host(&tmp);
    let root = host.installed("alpha");
    write(&root.join("plugin.json"), &manifest("alpha"));
    command_file(&root, "ship", "Ship the change.");
    let outside = tmp.0.join("outside.md");
    write(&outside, "---\ndescription: escaped\n---\n\nLeave.\n");
    std::os::unix::fs::symlink(
        &outside,
        root.join("hivra").join("commands").join("escaped.md"),
    )
    .unwrap();
    save(
        &host,
        vec![entry(
            "alpha",
            Enablement {
                global: true,
                projects: vec![],
            },
        )],
    );
    let listed = plugin_commands_for(&host, &tmp.0);
    assert_eq!(names(&listed), vec!["ship"]);
}
