//! WP-44: the carried plugin installs switched off, and consent edits compare-and-swap.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::desktop::{self, ConsentDoc, PendingAsk, ProjectConsent};
use super::fsutil;
use super::manifest::load_plugin;
use super::registry::{self, Host, Source};

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("hivra-desktop-{label}-{}", uuid::Uuid::new_v4()));
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

fn host_in(tmp: &Tmp) -> Host {
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    Host {
        root,
        agents_skills: tmp.path().join("agents-skills"),
    }
}

fn source_plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/desktop-control")
}

fn assert_installed(host: &Host, outcome: &registry::Outcome) {
    let entry = outcome.entry.as_ref().unwrap();
    assert_eq!(entry.name, "desktop-control");
    assert_eq!(entry.version.as_deref(), Some("1.1.0"));
    assert!(!entry.enabled.global);
    assert!(entry.enabled.projects.is_empty());
    let loaded = load_plugin(&host.installed("desktop-control")).unwrap();
    assert!(loaded
        .skills
        .iter()
        .any(|skill| skill.name == "agent-desktop"));
    assert!(outcome
        .reports
        .iter()
        .all(|report| report.path != "skills/agent-desktop"));
    let installed = host.installed("desktop-control");
    let pin: serde_json::Value =
        serde_json::from_slice(&std::fs::read(installed.join("pin.json")).unwrap()).unwrap();
    assert_eq!(pin["version"], "1.1.0");
    assert!(installed.join("bin").join("gate.mjs").is_file());
    assert!(!installed.join("package.json").exists());
}

fn doc(revision: u64) -> ConsentDoc {
    ConsentDoc {
        revision,
        next_id: 1,
        projects: BTreeMap::new(),
        pending: Vec::new(),
    }
}

#[test]
fn install_local_is_switched_off_and_loads_the_skill() {
    let tmp = Tmp::new("local");
    let host = host_in(&tmp);
    let outcome =
        registry::install_local(&host, &source_plugin(), Source::local(&source_plugin())).unwrap();
    assert_installed(&host, &outcome);
}

#[test]
fn install_bundled_matches_and_a_second_install_is_refused() {
    let tmp = Tmp::new("bundled");
    let host = host_in(&tmp);
    let outcome = desktop::install_bundled(&host).unwrap();
    assert_installed(&host, &outcome);
    assert_eq!(outcome.entry.as_ref().unwrap().source.kind, "bundled");
    assert_eq!(
        outcome.entry.as_ref().unwrap().source.pin.as_deref(),
        Some("1.1.0")
    );
    let again = desktop::install_bundled(&host).unwrap_err();
    assert!(again.contains("already installed"), "{again}");
}

#[test]
fn embedded_bytes_match_the_carried_plugin() {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path.strip_prefix(base).unwrap();
                let rel = rel
                    .components()
                    .map(|component| component.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    let root = fsutil::canonical(&source_plugin()).unwrap();
    let mut source = BTreeMap::new();
    walk(&root, &root, &mut source);
    let embedded: BTreeMap<String, (Vec<u8>, bool)> = desktop::FILES
        .iter()
        .map(|(rel, bytes, executable)| ((*rel).to_string(), (bytes.to_vec(), *executable)))
        .collect();
    assert_eq!(embedded.len(), source.len());
    for (rel, bytes) in source {
        let (stored, executable) = embedded
            .get(&rel)
            .unwrap_or_else(|| panic!("missing {rel}"));
        assert_eq!(stored, &bytes, "{rel}");
        assert_eq!(*executable, bytes.starts_with(b"#!"), "{rel}");
    }
}

#[test]
fn rel_parts_rejects_escape_and_accepts_a_file() {
    assert!(desktop::rel_parts("../x").is_none());
    assert!(desktop::rel_parts("a/../../b").is_none());
    assert!(desktop::rel_parts("a/./b").is_none());
    assert!(desktop::rel_parts("/abs").is_none());
    assert!(desktop::rel_parts("").is_none());
    assert_eq!(
        desktop::rel_parts("bin/gate.mjs"),
        Some(vec!["bin", "gate.mjs"])
    );
}

#[test]
fn consent_write_is_compare_and_swap() {
    let tmp = Tmp::new("cas");
    let path = tmp.path().join("consent.json");
    assert_eq!(desktop::read_consent(&path).unwrap().revision, 0);
    assert!(!path.exists());
    let written = desktop::write_consent(&path, 0, doc(1)).unwrap();
    assert_eq!(written.revision, 1);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.ends_with('\n'));
    assert!(!text.contains('\r'));
    assert!(text.contains("\"nextId\""));
    let before = std::fs::read(&path).unwrap();
    let stale = desktop::write_consent(&path, 0, doc(1)).unwrap_err();
    assert_eq!(stale, "That list changed. Look again.");
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn a_corrupt_consent_file_is_not_overwritten() {
    let tmp = Tmp::new("corrupt");
    let path = tmp.path().join("consent.json");
    std::fs::write(&path, b"{").unwrap();
    let error = desktop::write_consent(&path, 0, doc(1)).unwrap_err();
    assert_eq!(
        error,
        "The consent file can't be read, so it was left as it is."
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"{");
}

#[test]
fn a_fresh_lock_is_busy_and_a_stale_lock_is_reclaimed() {
    let tmp = Tmp::new("lock");
    let path = tmp.path().join("consent.json");
    std::fs::write(
        &path,
        b"{\"revision\":0,\"nextId\":1,\"projects\":{},\"pending\":[]}\n",
    )
    .unwrap();
    let before = std::fs::read(&path).unwrap();
    let lock = desktop::consent_lock(&path);
    std::fs::write(&lock, b"").unwrap();
    let busy = desktop::write_consent(&path, 0, doc(1)).unwrap_err();
    assert_eq!(busy, "Desktop consent is busy. Try again.");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(lock.exists());

    let handle = OpenOptions::new().write(true).open(&lock).unwrap();
    handle
        .set_modified(SystemTime::now() - Duration::from_secs(60))
        .unwrap();
    drop(handle);
    desktop::write_consent(&path, 0, doc(1)).unwrap();
    assert!(!lock.exists());
    assert_eq!(desktop::read_consent(&path).unwrap().revision, 1);
}

#[test]
fn crlf_consent_reads_and_bad_values_are_refused() {
    let tmp = Tmp::new("shape");
    let path = tmp.path().join("consent.json");
    std::fs::write(
        &path,
        "{\r\n  \"revision\": 2,\r\n  \"nextId\": 4,\r\n  \"projects\": {},\r\n  \"pending\": []\r\n}\r\n",
    )
    .unwrap();
    let read = desktop::read_consent(&path).unwrap();
    assert_eq!(read.revision, 2);
    assert_eq!(read.next_id, 4);

    let before = std::fs::read(&path).unwrap();
    let mut relative = doc(3);
    relative.projects.insert(
        "rel/proj".into(),
        ProjectConsent {
            apps: vec![],
            refused: vec![],
            visible: false,
        },
    );
    assert!(desktop::write_consent(&path, 2, relative).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);

    let mut nul = doc(3);
    nul.projects.insert(
        "/tmp/proj".into(),
        ProjectConsent {
            apps: vec!["No\u{0}tes".into()],
            refused: vec![],
            visible: false,
        },
    );
    assert!(desktop::write_consent(&path, 2, nul).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);

    let mut escaped = doc(3);
    escaped.projects.insert(
        "/tmp/foo/../bar".into(),
        ProjectConsent {
            apps: vec![],
            refused: vec![],
            visible: false,
        },
    );
    assert!(desktop::write_consent(&path, 2, escaped).is_err());

    let mut huge = doc(3);
    huge.pending = (0..201)
        .map(|index| PendingAsk {
            id: format!("ask-{index}"),
            project: "/tmp/proj".into(),
            app: "Mail".into(),
        })
        .collect();
    assert!(desktop::write_consent(&path, 2, huge).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn consent_is_refused_until_the_plugin_is_installed() {
    let tmp = Tmp::new("absent");
    let host = host_in(&tmp);
    assert_eq!(
        desktop::read_for_host(&host).unwrap_err(),
        "Desktop control isn't installed."
    );
    assert_eq!(
        desktop::write_for_host(&host, 0, doc(1)).unwrap_err(),
        "Desktop control isn't installed."
    );
    assert!(!host.root.join("data").exists());
}
