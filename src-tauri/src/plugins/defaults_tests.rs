//! WP-41's proofs: the carried pstack is exactly the pinned copy, a fresh (or existing) data folder gets it switched on
//! everywhere once, Claude Code and Codex sessions see its skills, and a person's off or remove sticks.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::defaults::{self, Outcome, Pin, SOURCE_KIND, STATE_FILE};
use super::fsutil;
use super::registry::{self, Host, Scope, Source};
use super::wiring;

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("hivra-defaults-{label}-{}", uuid::Uuid::new_v4()));
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

fn host(tmp: &Tmp) -> Host {
    let host = Host {
        root: tmp.path().join("app-data/plugins"),
        agents_skills: tmp.path().join("home/.agents/skills"),
    };
    std::fs::create_dir_all(tmp.path().join("home")).unwrap();
    host
}

fn pstack_pin() -> Pin {
    defaults::pins()
        .into_iter()
        .find(|p| p.name == "pstack")
        .expect("pstack is a default plugin")
}

fn carried(folder: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("plugins")
        .join(folder)
}

/// Every file under `dir`, relative with `/`, sorted.
fn files_under(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let rel: Vec<_> = path
                    .strip_prefix(base)
                    .unwrap()
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                out.push(rel.join("/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// Skill folders (immediate children holding a SKILL.md) in `dir`, sorted.
fn skills_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().join("SKILL.md").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

fn pstack_skills() -> Vec<String> {
    skills_in(&carried("pstack").join("skills"))
}

fn installed(name: &str) -> Outcome {
    Outcome::Installed { name: name.into() }
}

/// Pins run in defaults.json order: pstack, then the starter Monos (no skills, so no extra plugin dir), then Creator, then hivra-rpi, then hivra-mcode.
fn both_installed() -> Vec<Outcome> {
    vec![
        installed("pstack"),
        installed("starter-monos"),
        installed("hivra-creator"),
        installed("hivra-rpi"),
        installed("hivra-mcode"),
    ]
}

fn both_given() -> Vec<Outcome> {
    vec![
        Outcome::AlreadyGiven {
            name: "pstack".into(),
        },
        Outcome::AlreadyGiven {
            name: "starter-monos".into(),
        },
        Outcome::AlreadyGiven {
            name: "hivra-creator".into(),
        },
        Outcome::AlreadyGiven {
            name: "hivra-rpi".into(),
        },
        Outcome::AlreadyGiven {
            name: "hivra-mcode".into(),
        },
    ]
}

fn every_skill() -> Vec<String> {
    let mut skills = pstack_skills();
    skills.extend(skills_in(&carried("hivra-creator").join("skills")));
    skills.extend(skills_in(&carried("hivra-rpi").join("skills")));
    skills.extend(skills_in(&carried("hivra-mcode").join("skills")));
    skills.sort();
    skills
}

#[test]
fn the_pins_match_the_copies_the_app_carries() {
    let pins = defaults::pins();
    assert!(!pins.is_empty());
    let mut folders: Vec<String> =
        std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("plugins"))
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
    folders.sort();
    let mut pinned: Vec<String> = pins.iter().map(|p| p.folder.clone()).collect();
    pinned.sort();
    assert_eq!(
        folders, pinned,
        "every carried folder has a pin, and every pin a folder"
    );
    for pin in &pins {
        let dir = carried(&pin.folder);
        assert_eq!(
            pin.commit.len(),
            40,
            "{}: pinned to a full commit",
            pin.name
        );
        assert!(pin.commit.chars().all(|c| c.is_ascii_hexdigit()));
        // The embedded table is the folder, byte for byte.
        let mut embedded: Vec<(&str, &[u8])> = defaults::files(&pin.folder)
            .map(|(p, b, _)| (p, b))
            .collect();
        embedded.sort();
        let on_disk = files_under(&dir);
        assert_eq!(
            embedded
                .iter()
                .map(|(p, _)| p.to_string())
                .collect::<Vec<_>>(),
            on_disk
        );
        for (rel, bytes) in embedded {
            assert_eq!(std::fs::read(dir.join(rel)).unwrap(), bytes, "{rel}");
        }
        // The copy is the plugin it says it is, with its licence.
        let loaded = super::load_plugin(&dir).unwrap();
        assert_eq!(loaded.manifest.name, pin.name);
        assert_eq!(
            loaded.manifest.version.as_deref(),
            Some(pin.version.as_str())
        );
        let licence = std::fs::read_to_string(dir.join("LICENSE")).unwrap();
        assert!(
            licence.contains(&pin.copyright),
            "{}: LICENSE names {}",
            pin.name,
            pin.copyright
        );
        for left_out in &pin.left_out {
            assert!(
                !dir.join(left_out).exists(),
                "{}: {left_out} is left out",
                pin.name
            );
        }
    }
    let pstack = pstack_pin();
    assert_eq!(pstack.repository, "https://github.com/cursor/plugins");
    assert_eq!(pstack.license, "MIT");
    // Cursor-only parts aren't carried (WP-41 build step 2).
    for cursor_only in ["agents", "automations", ".cursor-plugin"] {
        assert!(pstack.left_out.iter().any(|l| l == cursor_only));
    }
}

#[test]
fn a_fresh_install_has_pstack_on_everywhere() {
    let tmp = Tmp::new("fresh");
    let host = host(&tmp);
    assert_eq!(defaults::ensure(&host), both_installed());

    let registry = registry::read(&host).unwrap();
    let entry = &registry.plugins["pstack"];
    let pin = pstack_pin();
    assert!(entry.enabled.global);
    assert_eq!(entry.version.as_deref(), Some(pin.version.as_str()));
    assert_eq!(entry.source, pin.source());
    assert_eq!(entry.source.kind, SOURCE_KIND);
    assert_eq!(
        entry.source.location,
        "https://github.com/cursor/plugins/tree/6ea74587e384e1a8035c09ae33a46fe3f881eb9b/pstack"
    );
    let skills = pstack_skills();
    assert_eq!(skills.len(), 58);
    let mut registered: Vec<String> = entry.skills().map(str::to_string).collect();
    registered.sort();
    assert_eq!(registered, skills, "every pstack skill loads");
    let starter = &registry.plugins["starter-monos"];
    assert!(starter.enabled.global);
    assert_eq!(
        starter.skills().count(),
        0,
        "starter monos add no plugin dir"
    );

    // Installed exactly as carried; the staging folder is gone.
    assert_eq!(
        files_under(&host.installed("pstack")),
        files_under(&carried("pstack"))
    );
    let leftovers: Vec<_> = std::fs::read_dir(&host.root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".default-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = host
            .installed("pstack")
            .join("skills/show-me-your-work/scripts/log.sh");
        assert_ne!(
            std::fs::metadata(script).unwrap().permissions().mode() & 0o111,
            0
        );
    }

    // Claude Code: one --plugin-dir per plugin. Codex and the other `.agents/skills` readers: a link each.
    let wired = wiring::session_wiring(&host, None, Some("<CLI>"), &Default::default()).unwrap();
    assert_eq!(wired.claude_plugin_dirs.len(), 4);
    let mut claude_skills = Vec::new();
    for dir in &wired.claude_plugin_dirs {
        claude_skills.extend(skills_in(&Path::new(dir).join("skills")));
    }
    claude_skills.sort();
    let expected = every_skill();
    assert_eq!(claude_skills, expected);
    assert_eq!(skills_in(&host.agents_skills), expected);
    // pstack has no MCP servers.
    assert!(wired.claude_mcp_servers.is_empty() && wired.codex_mcp_servers.is_empty());
}

#[test]
fn every_later_start_changes_nothing() {
    let tmp = Tmp::new("again");
    let host = host(&tmp);
    defaults::ensure(&host);
    let before = fsutil::tree(&[tmp.path()]);
    let registry_before = std::fs::read_to_string(host.root.join("registry.json")).unwrap();
    assert_eq!(defaults::ensure(&host), both_given());
    assert_eq!(fsutil::tree(&[tmp.path()]), before);
    assert_eq!(
        std::fs::read_to_string(host.root.join("registry.json")).unwrap(),
        registry_before
    );
}

#[test]
fn switched_off_stays_off_and_removed_stays_removed() {
    let tmp = Tmp::new("off");
    let host = host(&tmp);
    defaults::ensure(&host);

    registry::disable(&host, "pstack", &Scope::Global).unwrap();
    let wired = wiring::session_wiring(&host, None, None, &Default::default()).unwrap();
    let off = skills_in(&host.agents_skills);
    assert!(
        !off.iter().any(|skill| skill == "tdd"),
        "Codex gets no pstack: {off:?}"
    );
    assert!(
        off.iter().any(|skill| skill == "write-skill"),
        "the Creator skills stay: {off:?}"
    );
    assert!(
        off.iter().any(|skill| skill == "rpi-tdd"),
        "hivra-rpi stays when pstack is off: {off:?}"
    );
    assert!(
        !wired.claude_plugin_dirs.is_empty(),
        "hivra-creator is still on"
    );
    defaults::ensure(&host);
    assert!(!registry::read(&host).unwrap().plugins["pstack"]
        .enabled
        .any());

    registry::uninstall(&host, "pstack").unwrap();
    defaults::ensure(&host);
    let registry = registry::read(&host).unwrap();
    assert!(
        !registry.plugins.contains_key("pstack"),
        "a removed pstack is not put back"
    );
    assert!(registry.plugins["starter-monos"].enabled.global);
    assert!(registry.plugins.contains_key("hivra-creator"));
    assert!(!host.installed("pstack").exists());
    assert!(host.installed("starter-monos").exists());
    assert!(host.installed("hivra-creator").exists());
    // starter-monos and hivra-creator are still installed, so their records stay. pstack's folders are gone.
    let names = |dir: &std::path::Path| -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    };
    assert_eq!(
        names(&host.root),
        vec![
            "claude".to_string(),
            "data".to_string(),
            STATE_FILE.to_string(),
            "installed".to_string(),
            "lock.json".to_string(),
            "registry.json".to_string(),
        ],
        "nothing else is left behind"
    );
    assert_eq!(
        names(&host.root.join("installed")),
        vec![
            "hivra-creator".to_string(),
            "hivra-mcode".to_string(),
            "hivra-rpi".to_string(),
            "starter-monos".to_string()
        ]
    );
    assert_eq!(
        names(&host.root.join("data")),
        vec![
            "hivra-creator".to_string(),
            "hivra-mcode".to_string(),
            "hivra-rpi".to_string(),
            "starter-monos".to_string()
        ]
    );
    let still = skills_in(&host.agents_skills);
    assert!(
        still.iter().any(|skill| skill == "write-skill"),
        "the Creator skills stay: {still:?}"
    );
    assert!(
        !still.iter().any(|skill| skill == "tdd"),
        "pstack stays removed: {still:?}"
    );
    assert!(
        still.iter().any(|skill| skill == "rpi-tdd"),
        "hivra-rpi stays removed from pstack, not from the app: {still:?}"
    );
    // A removed default is not put back. Uninstall the rest, and only the memory that they were given stays.
    registry::uninstall(&host, "hivra-creator").unwrap();
    registry::uninstall(&host, "hivra-mcode").unwrap();
    registry::uninstall(&host, "hivra-rpi").unwrap();
    registry::uninstall(&host, "starter-monos").unwrap();
    defaults::ensure(&host);
    assert!(registry::read(&host).unwrap().plugins.is_empty());
    assert_eq!(
        names(&host.root),
        vec![STATE_FILE.to_string()],
        "nothing else is left behind"
    );
    assert!(skills_in(&host.agents_skills).is_empty());
}

#[test]
fn an_existing_install_gets_it_once() {
    let tmp = Tmp::new("existing");
    let host = host(&tmp);
    // An install from before WP-41: another plugin, no record of defaults.
    let other = tmp.path().join("src/other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(
        other.join("plugin.json"),
        json!({ "$schema": super::manifest::PLUGIN_SCHEMA_1_0_0, "name": "other" }).to_string(),
    )
    .unwrap();
    registry::install_local(&host, &other, Source::local(&other)).unwrap();
    assert_eq!(defaults::ensure(&host), both_installed());
    let registry = registry::read(&host).unwrap();
    assert!(registry.plugins["pstack"].enabled.global);
    assert!(
        !registry.plugins["other"].enabled.any(),
        "other plugins are left as they were"
    );
    assert_eq!(defaults::ensure(&host), both_given());
}

#[test]
fn a_pstack_the_person_installed_themselves_is_left_alone() {
    let tmp = Tmp::new("theirs");
    let host = host(&tmp);
    let theirs = carried("pstack");
    registry::install_local(&host, &theirs, Source::local(&theirs)).unwrap();
    assert_eq!(
        defaults::ensure(&host),
        vec![
            Outcome::TheirOwn {
                name: "pstack".into()
            },
            installed("starter-monos"),
            installed("hivra-creator"),
            installed("hivra-rpi"),
            installed("hivra-mcode"),
        ]
    );
    let entry = &registry::read(&host).unwrap().plugins["pstack"];
    assert_eq!(entry.source.kind, "local");
    assert!(!entry.enabled.any(), "not switched on behind their back");
    registry::uninstall(&host, "pstack").unwrap();
}

#[test]
fn a_start_cut_after_the_install_finishes_the_job() {
    let tmp = Tmp::new("cut");
    let host = host(&tmp);
    let pin = pstack_pin();
    let staging = tmp.path().join("staging");
    let dir = defaults::unpack(&pin, &staging).unwrap();
    registry::install_local(&host, &dir, pin.source()).unwrap();
    // No switch-on, no record: the app stopped here. starter-monos and hivra-creator were never installed, so they are given too.
    assert_eq!(defaults::ensure(&host), both_installed());
    assert!(
        registry::read(&host).unwrap().plugins["pstack"]
            .enabled
            .global
    );
}

#[test]
fn a_failed_start_tries_again_next_time() {
    let tmp = Tmp::new("retry");
    let host = host(&tmp);
    // The plugin folder can't be made: a file is in the way.
    std::fs::create_dir_all(tmp.path().join("app-data")).unwrap();
    std::fs::write(&host.root, "not a folder").unwrap();
    let failed = defaults::ensure(&host);
    assert_eq!(failed.len(), defaults::pins().len(), "{failed:?}");
    assert!(
        failed
            .iter()
            .all(|outcome| matches!(outcome, Outcome::Failed { .. })),
        "{failed:?}"
    );
    std::fs::remove_file(&host.root).unwrap();
    assert_eq!(defaults::ensure(&host), both_installed());
}

/// lock.json is every bundled plugin. The session snapshot is the pstack wiring plus Creator, so starter-monos is
/// removed and the file is written again the way registry.rs writes it (pretty, then a newline). Only the Unix
/// session test uses it.
#[cfg(unix)]
fn pstack_only_lock(raw: &str) -> String {
    let mut lock: registry::LockFile = serde_json::from_str(raw.trim()).unwrap();
    lock.plugins.remove("starter-monos");
    format!("{}\n", serde_json::to_string_pretty(&lock).unwrap())
}

/// The session test (`src/features/plugins/model/pstackSessions.test.ts`) replays what the real Claude Code and Codex
/// adapters hand a fake CLI when pstack is on, and when it is off. This records the Rust side of both: the wiring, the
/// Claude shim's files and every link, with the installed copy itself named rather than listed (the TS test copies
/// `src-tauri/plugins/pstack` there, which the tests above prove is what gets installed). Rerun with
/// `UPDATE_PLUGIN_WIRING_SNAPSHOT=1` after changing the wiring on purpose.
#[cfg(unix)]
#[test]
fn the_pstack_snapshot_for_the_session_test_is_current() {
    let tmp = Tmp::new("pstack-snapshot");
    let host = host(&tmp);
    let base = tmp.path().display().to_string();
    let rel = |text: &str| text.replace(&base, "<TMP>");
    let pstack_dir = host.installed("pstack");
    let creator_dir = host.installed("hivra-creator");
    let rpi_dir = host.installed("hivra-rpi");
    let mcode_dir = host.installed("hivra-mcode");
    let record = |tmp: &Tmp| -> Vec<serde_json::Value> {
        #[allow(clippy::too_many_arguments)] // WP-117: test walker carries one dir per bundled skill pack
        fn walk(
            base: &Path,
            dir: &Path,
            pstack_dir: &Path,
            creator_dir: &Path,
            rpi_dir: &Path,
            mcode_dir: &Path,
            rel: &dyn Fn(&str) -> String,
            out: &mut Vec<serde_json::Value>,
        ) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let path = entry.path();
                let name = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                if name.ends_with("registry.json") || name.ends_with(STATE_FILE) {
                    continue; // install times and the given-once record; the session test reads neither
                }
                // The snapshot is the pstack wiring. starter-monos has no skills and no MCP, so it is not part of it.
                if name.contains("starter-monos") {
                    continue;
                }
                let meta = std::fs::symlink_metadata(&path).unwrap();
                if path == pstack_dir || path == creator_dir || path == rpi_dir || path == mcode_dir
                {
                    let carried = if path == pstack_dir {
                        "pstack"
                    } else if path == creator_dir {
                        "hivra-creator"
                    } else if path == rpi_dir {
                        "hivra-rpi"
                    } else {
                        "hivra-mcode"
                    };
                    out.push(json!({ "path": name, "carried": carried }));
                } else if meta.file_type().is_symlink() {
                    let target = std::fs::read_link(&path).unwrap();
                    let target = target
                        .strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned();
                    out.push(json!({ "path": name, "link": target }));
                } else if meta.is_dir() {
                    out.push(json!({ "path": name, "dir": true }));
                    walk(
                        base,
                        &path,
                        pstack_dir,
                        creator_dir,
                        rpi_dir,
                        mcode_dir,
                        rel,
                        out,
                    );
                } else {
                    let raw = std::fs::read_to_string(&path).unwrap();
                    // lock.json lists every bundled plugin. The snapshot is the pstack wiring, so the
                    // starter-monos pin is taken out before the text is compared. Same writer as registry.rs.
                    let body = if name.ends_with("plugins/lock.json") {
                        pstack_only_lock(&raw)
                    } else {
                        raw
                    };
                    out.push(json!({ "path": name, "text": rel(&body) }));
                }
            }
        }
        let mut out = Vec::new();
        walk(
            tmp.path(),
            tmp.path(),
            &pstack_dir,
            &creator_dir,
            &rpi_dir,
            &mcode_dir,
            &rel,
            &mut out,
        );
        out
    };
    defaults::ensure(&host);
    let on = wiring::session_wiring(&host, None, Some("<CLI>"), &Default::default()).unwrap();
    let on = json!({ "wiring": serde_json::from_str::<serde_json::Value>(&rel(&serde_json::to_string(&on).unwrap())).unwrap(), "files": record(&tmp) });
    registry::disable(&host, "pstack", &Scope::Global).unwrap();
    let off = wiring::session_wiring(&host, None, Some("<CLI>"), &Default::default()).unwrap();
    let off = json!({ "wiring": serde_json::from_str::<serde_json::Value>(&rel(&serde_json::to_string(&off).unwrap())).unwrap(), "files": record(&tmp) });
    let snapshot = json!({
        "about": "Made by src-tauri/src/plugins/defaults_tests.rs (the_pstack_snapshot_for_the_session_test_is_current). Don't edit by hand.",
        "skills": pstack_skills(),
        "on": on,
        "off": off,
    });
    let text = format!("{}\n", serde_json::to_string_pretty(&snapshot).unwrap());
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/plugins/model/__fixtures__/rust-pstack.json");
    if std::env::var_os("UPDATE_PLUGIN_WIRING_SNAPSHOT").is_some() {
        std::fs::write(&path, &text).unwrap();
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        committed, text,
        "the pstack wiring changed: rerun with UPDATE_PLUGIN_WIRING_SNAPSHOT=1 and check the TS session test"
    );
}
