//! WP-44: the carried plugin installs switched off, and consent edits compare-and-swap.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::desktop::{self, ConsentDoc, PendingAsk, ProjectConsent};
use super::desktop_program::{self, PlatformFiles};
use super::fsutil;
use super::manifest::load_plugin;
use super::registry::{self, Host, Scope, Source};
use super::source::sha512_integrity;
use super::wiring;

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
    assert_eq!(entry.version.as_deref(), Some("1.2.0"));
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
    assert_eq!(pin["version"], "1.2.0");
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
        Some("1.2.0")
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
fn a_new_allow_is_one_grant_and_a_refusal_or_a_repeat_is_not() {
    let tmp = Tmp::new("activity");
    let db = tmp.path().join("monocode.db");
    drop(crate::session_store::SessionStore::open(db.clone()).unwrap());
    let project = tmp.path().join("Work folder");
    std::fs::create_dir_all(&project).unwrap();
    let key = project.display().to_string();
    let path = tmp.path().join("plugins/data/desktop-control/consent.json");
    let mut consent = doc(1);
    consent.projects.insert(
        key.clone(),
        ProjectConsent {
            apps: vec!["Notes".into()],
            refused: vec!["Mail".into()],
            visible: false,
        },
    );
    desktop::write_consent(&path, 0, consent.clone()).unwrap();
    consent.revision = 2;
    desktop::write_consent(&path, 1, consent).unwrap();
    let mut cleared = doc(3);
    cleared.projects.insert(
        key.clone(),
        ProjectConsent {
            apps: Vec::new(),
            refused: vec!["Mail".into()],
            visible: false,
        },
    );
    desktop::write_consent(&path, 2, cleared).unwrap();
    // Not this app's consent file: no database is inferred, and nothing is logged.
    desktop::write_consent(&tmp.path().join("consent.json"), 0, doc(1)).unwrap();
    let store = crate::session_store::SessionStore::open(db).unwrap();
    let conn = store.lock_conn().unwrap();
    let rows = crate::activity::list(
        &conn,
        &crate::activity::ListQuery {
            limit: Some(20),
            ..Default::default()
        },
        crate::session_store::now_millis(),
    )
    .unwrap()
    .entries;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].kind, crate::activity::PERMISSION_GRANT);
    assert_eq!(rows[0].actor, crate::activity::Who::person());
    assert_eq!(rows[0].initiator, crate::activity::Who::person());
    assert_eq!(rows[0].project, key);
    assert_eq!(rows[0].target, "Notes");
    assert_eq!(rows[0].summary, "Allowed Notes.");
    assert!(!rows[0].summary.contains("Mail"));
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
fn a_live_owner_is_not_reclaimed_when_the_lock_is_old() {
    let tmp = Tmp::new("live-lock");
    let path = tmp.path().join("consent.json");
    std::fs::write(
        &path,
        b"{\"revision\":0,\"nextId\":1,\"projects\":{},\"pending\":[]}\n",
    )
    .unwrap();
    let before = std::fs::read(&path).unwrap();
    let lock = desktop::consent_lock(&path);
    let body = format!("{}\nsecret-token\n", std::process::id());
    std::fs::write(&lock, &body).unwrap();
    let handle = OpenOptions::new().write(true).open(&lock).unwrap();
    handle
        .set_modified(SystemTime::now() - Duration::from_secs(60))
        .unwrap();
    drop(handle);
    let busy = desktop::write_consent(&path, 0, doc(1)).unwrap_err();
    assert_eq!(busy, "Desktop consent is busy. Try again.");
    assert_eq!(std::fs::read(&lock).unwrap(), body.as_bytes());
    assert_eq!(std::fs::read(&path).unwrap(), before);
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

    // An empty lock has no owner. Age does not make it ours to take.
    let handle = OpenOptions::new().write(true).open(&lock).unwrap();
    handle
        .set_modified(SystemTime::now() - Duration::from_secs(60))
        .unwrap();
    drop(handle);
    let still = desktop::write_consent(&path, 0, doc(1)).unwrap_err();
    assert_eq!(still, "Desktop consent is busy. Try again.");
    assert!(lock.exists());
    assert_eq!(std::fs::read(&path).unwrap(), before);

    // A dead owner is reclaimed, and the bytes have to still be that owner's.
    let dead = dead_pid();
    std::fs::write(&lock, format!("{dead}\ndead-token\n")).unwrap();
    desktop::write_consent(&path, 0, doc(1)).unwrap();
    assert!(!lock.exists());
    assert_eq!(desktop::read_consent(&path).unwrap().revision, 1);
}

fn dead_pid() -> u32 {
    let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
        .args(if cfg!(windows) {
            vec!["/C", "exit 0"]
        } else {
            vec!["-c", "exit 0"]
        })
        .spawn()
        .unwrap();
    let pid = child.id();
    let _ = child.wait();
    pid
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

#[test]
fn the_app_starts_the_desktop_server_with_its_own_paths() {
    let tmp = Tmp::new("mcp");
    let host = host_in(&tmp);
    registry::install_local(&host, &source_plugin(), Source::local(&source_plugin())).unwrap();
    registry::enable(&host, "desktop-control", &Scope::Global).unwrap();
    let args = vec![
        "--root".into(),
        host.root.display().to_string(),
        "--plugin".into(),
        "desktop-control".into(),
        "--server".into(),
        "desktop".into(),
    ];
    std::env::set_var("HIVRA_DESKTOP_REGISTRY", "/tmp/worker-registry.json");
    let command = wiring::prepare_launch(&args).unwrap();
    std::env::remove_var("HIVRA_DESKTOP_REGISTRY");

    let env = |key: &str| -> Option<String> {
        command
            .get_envs()
            .find(|(name, _)| *name == key)
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    };
    assert!(env("HIVRA_DESKTOP_REGISTRY").is_none());
    let registry = host.root.join("registry.json").display().to_string();
    assert_eq!(
        env("DESKTOP_LAUNCH_REGISTRY").as_deref(),
        Some(registry.as_str())
    );
    let data = host.data("desktop-control");
    let consent = data.join("consent.json").display().to_string();
    assert_eq!(
        env("DESKTOP_LAUNCH_CONSENT").as_deref(),
        Some(consent.as_str())
    );
    let binary = env("DESKTOP_LAUNCH_BINARY").unwrap();
    let binary_name = if cfg!(windows) {
        "agent-desktop.exe"
    } else {
        "agent-desktop"
    };
    assert_eq!(binary, data.join(binary_name).display().to_string());
    assert!(env("DESKTOP_LAUNCH_PROJECT").is_none());
    let installed = host.installed("desktop-control").display().to_string();
    assert!(
        !binary.starts_with(&installed),
        "binary {binary} is inside the plugin"
    );
    let pin = host
        .installed("desktop-control")
        .join("pin.json")
        .display()
        .to_string();
    assert_eq!(env("DESKTOP_LAUNCH_PIN").as_deref(), Some(pin.as_str()));
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(args.iter().any(|arg| arg == "--mcp"), "{args:?}");
    assert_eq!(command.get_program().to_string_lossy(), "node");
}

fn octal_field(value: u64, width: usize) -> Vec<u8> {
    let text = format!("{:0width$o}", value, width = width - 1);
    assert_eq!(text.len(), width - 1, "{text}");
    let mut bytes = text.into_bytes();
    bytes.push(0);
    bytes
}

/// A ustar entry, including ones the `tar` crate refuses to build (`..`).
fn ustar(name: &str, bytes: &[u8]) -> Vec<u8> {
    assert!(name.len() < 100, "{name}");
    let mut header = vec![0u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    header[100..108].copy_from_slice(&octal_field(0o755, 8));
    header[108..116].copy_from_slice(&octal_field(0, 8));
    header[116..124].copy_from_slice(&octal_field(0, 8));
    header[124..136].copy_from_slice(&octal_field(bytes.len() as u64, 12));
    header[136..148].copy_from_slice(&octal_field(0, 12));
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
    let digits = format!("{sum:06o}");
    assert_eq!(digits.len(), 6);
    header[148..154].copy_from_slice(digits.as_bytes());
    header[154] = 0;
    header[155] = b' ';
    header.extend_from_slice(bytes);
    let pad = (512 - (bytes.len() % 512)) % 512;
    header.extend(std::iter::repeat_n(0, pad));
    header
}

fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut raw = Vec::new();
    for (name, bytes) in entries {
        raw.extend(ustar(name, bytes));
    }
    raw.extend(std::iter::repeat_n(0u8, 1024));
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&raw).unwrap();
    gz.finish().unwrap()
}

fn dir_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn marked(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("marker"), b"keep").unwrap();
}

struct PinnedArchive {
    bytes: Vec<u8>,
    integrity: String,
    entry: PlatformFiles,
}

fn darwin_archive(binary: &[u8], helper: &[u8]) -> PinnedArchive {
    let bytes = tar_gz(&[
        ("package/bin/agent-desktop-darwin-arm64", binary),
        (
            "package/bin/agent-desktop-macos-helper-darwin-arm64",
            helper,
        ),
        (
            "package/package.json",
            br#"{"scripts":{"postinstall":"nope"}}"#,
        ),
    ]);
    let entry = PlatformFiles {
        binary_name: "agent-desktop-darwin-arm64".into(),
        sha256: desktop_program::sha256_hex(binary),
        helper_name: Some("agent-desktop-macos-helper-darwin-arm64".into()),
        helper_sha256: Some(desktop_program::sha256_hex(helper)),
    };
    let integrity = sha512_integrity(&bytes);
    PinnedArchive {
        bytes,
        integrity,
        entry,
    }
}

#[test]
fn a_wrong_integrity_writes_nothing() {
    let tmp = Tmp::new("integrity");
    let dest = tmp.path().join("out");
    marked(&dest);
    let pinned = darwin_archive(b"program", b"helper");
    let err = desktop_program::install_program(
        &pinned.bytes,
        "sha512-not-the-real-integrity",
        "darwin-arm64",
        &pinned.entry,
        &dest,
    )
    .unwrap_err();
    assert!(err.contains("doesn't match the pin"), "{err}");
    assert_eq!(dir_names(&dest), ["marker"]);
    assert_eq!(std::fs::read(dest.join("marker")).unwrap(), b"keep");
}

#[test]
fn a_wrong_file_hash_writes_nothing() {
    let tmp = Tmp::new("hash");
    let dest = tmp.path().join("out");
    marked(&dest);
    let mut pinned = darwin_archive(b"program", b"helper");
    pinned.entry.sha256 = "ab".repeat(32);
    let err = desktop_program::install_program(
        &pinned.bytes,
        &pinned.integrity,
        "darwin-arm64",
        &pinned.entry,
        &dest,
    )
    .unwrap_err();
    assert!(err.contains("doesn't match the pin"), "{err}");
    assert_eq!(dir_names(&dest), ["marker"]);
}

#[test]
fn a_path_that_leaves_the_archive_writes_nothing() {
    let tmp = Tmp::new("escape");
    let dest = tmp.path().join("out");
    marked(&dest);
    let binary = b"program";
    let bytes = tar_gz(&[
        ("package/bin/agent-desktop-darwin-arm64", binary),
        ("package/bin/../../wp44-escaped-marker", b"escaped"),
        (
            "package/bin/agent-desktop-macos-helper-darwin-arm64",
            b"helper",
        ),
    ]);
    let entry = PlatformFiles {
        binary_name: "agent-desktop-darwin-arm64".into(),
        sha256: desktop_program::sha256_hex(binary),
        helper_name: Some("agent-desktop-macos-helper-darwin-arm64".into()),
        helper_sha256: Some(desktop_program::sha256_hex(b"helper")),
    };
    let err = desktop_program::install_program(
        &bytes,
        &sha512_integrity(&bytes),
        "darwin-arm64",
        &entry,
        &dest,
    )
    .unwrap_err();
    assert!(err.contains("leaves its folder"), "{err}");
    assert_eq!(dir_names(&dest), ["marker"]);
    assert!(!tmp.path().join("wp44-escaped-marker").exists());
    assert!(!std::env::current_dir()
        .unwrap()
        .join("wp44-escaped-marker")
        .exists());
}

#[test]
fn a_good_archive_writes_only_this_platforms_program() {
    let tmp = Tmp::new("install");
    let dest = tmp.path().join("out");
    marked(&dest);
    let pinned = darwin_archive(b"program-bytes", b"helper-bytes");
    desktop_program::install_program(
        &pinned.bytes,
        &pinned.integrity,
        "darwin-arm64",
        &pinned.entry,
        &dest,
    )
    .unwrap();
    assert_eq!(
        dir_names(&dest),
        ["agent-desktop", "agent-desktop-macos-helper", "marker"]
    );
    assert_eq!(
        std::fs::read(dest.join("agent-desktop")).unwrap(),
        b"program-bytes"
    );
    assert_eq!(
        std::fs::read(dest.join("agent-desktop-macos-helper")).unwrap(),
        b"helper-bytes"
    );
    assert!(!dest.join("package.json").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dest.join("agent-desktop"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        let helper = std::fs::metadata(dest.join("agent-desktop-macos-helper"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(helper & 0o777, 0o755);
    }
    #[cfg(windows)]
    {
        assert!(dest.join("agent-desktop").is_file());
        assert!(dest.join("agent-desktop-macos-helper").is_file());
    }
}

#[test]
fn windows_gets_the_exe_and_linux_gets_the_clipboard_owner() {
    let tmp = Tmp::new("names");
    let win = tmp.path().join("win");
    marked(&win);
    let exe = b"windows-program";
    let win_bytes = tar_gz(&[("package/bin/agent-desktop-win32-x64.exe", exe)]);
    let win_entry = PlatformFiles {
        binary_name: "agent-desktop-win32-x64.exe".into(),
        sha256: desktop_program::sha256_hex(exe),
        helper_name: None,
        helper_sha256: None,
    };
    desktop_program::install_program(
        &win_bytes,
        &sha512_integrity(&win_bytes),
        "win32-x64",
        &win_entry,
        &win,
    )
    .unwrap();
    assert_eq!(dir_names(&win), ["agent-desktop.exe", "marker"]);
    assert!(!win.join("agent-desktop").exists());

    let linux = tmp.path().join("linux");
    marked(&linux);
    let program = b"linux-program";
    let owner = b"clipboard-owner";
    let linux_bytes = tar_gz(&[
        ("package/bin/agent-desktop-linux-x64", program),
        (
            "package/bin/agent-desktop-linux-clipboard-owner-linux-x64",
            owner,
        ),
    ]);
    let linux_entry = PlatformFiles {
        binary_name: "agent-desktop-linux-x64".into(),
        sha256: desktop_program::sha256_hex(program),
        helper_name: Some("agent-desktop-linux-clipboard-owner-linux-x64".into()),
        helper_sha256: Some(desktop_program::sha256_hex(owner)),
    };
    desktop_program::install_program(
        &linux_bytes,
        &sha512_integrity(&linux_bytes),
        "linux-x64",
        &linux_entry,
        &linux,
    )
    .unwrap();
    assert_eq!(
        dir_names(&linux),
        [
            "agent-desktop",
            "agent-desktop-linux-clipboard-owner",
            "marker"
        ]
    );
}

#[test]
fn fetching_uses_the_pinned_url_and_never_the_network_stand_in_on_a_bad_pin() {
    let tmp = Tmp::new("fetch");
    let host = host_in(&tmp);
    let mut calls = 0;
    let err = desktop_program::fetch_for_host(&host, "darwin-arm64", |_| {
        calls += 1;
        Ok(Vec::new())
    })
    .unwrap_err();
    assert_eq!(err, "Desktop control isn't installed.");
    assert_eq!(calls, 0);

    let pin_dir = host.installed("desktop-control");
    std::fs::create_dir_all(&pin_dir).unwrap();
    let write_pin = |url: &str, integrity: &str| {
        let pin = serde_json::json!({
            "url": url,
            "integrity": integrity,
            "platforms": {
                "darwin-arm64": {
                    "binary": "agent-desktop-darwin-arm64",
                    "sha256": "ab".repeat(32),
                    "helper": "agent-desktop-macos-helper-darwin-arm64",
                    "helperSha256": "cd".repeat(32),
                }
            }
        });
        std::fs::write(pin_dir.join("pin.json"), serde_json::to_vec(&pin).unwrap()).unwrap();
    };
    write_pin(
        "https://example.invalid/other.tgz",
        desktop_program::TARBALL_INTEGRITY,
    );
    let err = desktop_program::fetch_for_host(&host, "darwin-arm64", |_| {
        calls += 1;
        Ok(Vec::new())
    })
    .unwrap_err();
    assert!(err.contains("pin isn't set"), "{err}");
    assert_eq!(calls, 0);

    write_pin(desktop_program::TARBALL_URL, "sha512-not-the-published-one");
    let err = desktop_program::fetch_for_host(&host, "darwin-arm64", |_| {
        calls += 1;
        Ok(Vec::new())
    })
    .unwrap_err();
    assert!(err.contains("pin isn't set"), "{err}");
    assert_eq!(calls, 0);

    write_pin(
        desktop_program::TARBALL_URL,
        desktop_program::TARBALL_INTEGRITY,
    );
    let data = host.data("desktop-control");
    marked(&data);
    let mut seen = String::new();
    let err = desktop_program::fetch_for_host(&host, "darwin-arm64", |url| {
        calls += 1;
        seen = url.to_string();
        Ok(b"not-a-tarball".to_vec())
    })
    .unwrap_err();
    assert!(err.contains("doesn't match the pin"), "{err}");
    assert_eq!(calls, 1);
    assert_eq!(seen, desktop_program::TARBALL_URL);
    assert_eq!(dir_names(&data), ["marker"]);
}

#[test]
fn the_shipped_pin_is_the_published_program() {
    let pin: serde_json::Value =
        serde_json::from_str(include_str!("../../../plugins/desktop-control/pin.json")).unwrap();
    assert_eq!(pin["url"], desktop_program::TARBALL_URL);
    assert_eq!(pin["integrity"], desktop_program::TARBALL_INTEGRITY);
    let rows = [
        (
            "darwin-arm64",
            "agent-desktop-darwin-arm64",
            "dec75e0bba0d1f9b589bdb88188770ad1a199cde9e02cf0a5b94175491f738e9",
            Some((
                "agent-desktop-macos-helper-darwin-arm64",
                "4a795a40ba7fc93b726b0834342f0225779c30d83e28f1f219db479860c38a78",
            )),
        ),
        (
            "darwin-x64",
            "agent-desktop-darwin-x64",
            "5dae755fee4af37d1a245f058139b262d358352cce15aeb49d0100ff46b12156",
            Some((
                "agent-desktop-macos-helper-darwin-x64",
                "bdf060658b93f326efa06ac24d521e88025bf88109cecc257fa7fa40e65801cd",
            )),
        ),
        (
            "linux-x64",
            "agent-desktop-linux-x64",
            "da52a1eb2152cdc21b756ab20e6208d242da8062c73cd20bc8a8ae2a0384392c",
            Some((
                "agent-desktop-linux-clipboard-owner-linux-x64",
                "3e96f92b805c0d1f9de309935d62f4189b8e11e1385ad022bb878487bb3942ec",
            )),
        ),
        (
            "linux-arm64",
            "agent-desktop-linux-arm64",
            "915de59a8b3d22c9ad33023740bbcc5fe0b4fa830de9587bbf761237eafeb76f",
            Some((
                "agent-desktop-linux-clipboard-owner-linux-arm64",
                "a6bfde6778dadcf9fd04ba94de17cdf205eb0b23b643c3f34073d264d2117cc3",
            )),
        ),
        (
            "win32-x64",
            "agent-desktop-win32-x64.exe",
            "d274667031322e50b9c2b1ab81c2ca46835d52cc932769a5c34bd4d481fd94c3",
            None,
        ),
        (
            "win32-arm64",
            "agent-desktop-win32-arm64.exe",
            "f1577d9f8cb6c9b1e767584fed96c72fbe1591fefbd67100965607d1a337a2fb",
            None,
        ),
    ];
    let platforms = pin["platforms"].as_object().unwrap();
    assert_eq!(platforms.len(), rows.len());
    for (key, binary, sha, helper) in rows {
        let entry = &platforms[key];
        assert_eq!(entry["binary"], binary, "{key}");
        assert_eq!(entry["sha256"], sha, "{key}");
        match helper {
            Some((name, hash)) => {
                assert_eq!(entry["helper"], name, "{key}");
                assert_eq!(entry["helperSha256"], hash, "{key}");
            }
            None => {
                assert!(entry.get("helper").is_none(), "{key}");
                assert!(entry.get("helperSha256").is_none(), "{key}");
            }
        }
    }
}

#[test]
fn platform_key_uses_node_names() {
    let key = desktop_program::platform_key();
    assert!(!key.contains("macos"), "{key}");
    assert!(!key.contains("aarch64"), "{key}");
    assert!(!key.contains("x86_64"), "{key}");
    assert_eq!(key.split('-').count(), 2, "{key}");
}

fn git(dir: &Path, args: &[&str]) {
    let status = crate::git_cmd::git()
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "WP-44")
        .env("GIT_AUTHOR_EMAIL", "wp44@example.com")
        .env("GIT_COMMITTER_NAME", "WP-44")
        .env("GIT_COMMITTER_EMAIL", "wp44@example.com")
        .status()
        .unwrap_or_else(|error| panic!("git {args:?}: {error}"));
    assert!(status.success(), "git {args:?} -> {status}");
}

#[test]
fn a_worktree_of_an_allowed_project_uses_the_main_checkout() {
    let tmp = Tmp::new("worktree");
    let main = tmp.path().join("main");
    let linked = tmp.path().join("linked");
    let hooks = tmp.path().join("hooks");
    std::fs::create_dir_all(&main).unwrap();
    std::fs::create_dir_all(&hooks).unwrap();
    git(&main, &["init"]);
    git(&main, &["config", "user.email", "wp44@example.com"]);
    git(&main, &["config", "user.name", "WP-44"]);
    git(&main, &["config", "commit.gpgsign", "false"]);
    std::fs::write(main.join("README"), "notes\n").unwrap();
    git(&main, &["add", "README"]);
    git(
        &main,
        &[
            "-c",
            &format!("core.hooksPath={}", hooks.display()),
            "commit",
            "-m",
            "start",
        ],
    );
    git(
        &main,
        &["worktree", "add", "--detach", &linked.display().to_string()],
    );

    let expect = fsutil::canonical(&main).unwrap();
    assert_eq!(wiring::main_checkout(&linked), expect);
    assert_ne!(fsutil::canonical(&linked).unwrap(), expect);
    let plain = tmp.path().join("plain");
    std::fs::create_dir(&plain).unwrap();
    assert_eq!(
        wiring::main_checkout(&plain),
        fsutil::canonical(&plain).unwrap()
    );

    let host = host_in(&tmp);
    registry::install_local(&host, &source_plugin(), Source::local(&source_plugin())).unwrap();
    registry::enable(
        &host,
        "desktop-control",
        &Scope::Project(expect.display().to_string()),
    )
    .unwrap();
    let args = vec![
        "--root".into(),
        host.root.display().to_string(),
        "--plugin".into(),
        "desktop-control".into(),
        "--server".into(),
        "desktop".into(),
        "--project".into(),
        linked.display().to_string(),
    ];
    let command = wiring::prepare_launch(&args).expect("a worktree of an allowed project starts");
    let project = command
        .get_envs()
        .find(|(name, _)| *name == "DESKTOP_LAUNCH_PROJECT")
        .and_then(|(_, value)| value)
        .map(|value| value.to_string_lossy().into_owned());
    assert_eq!(
        project.as_deref(),
        Some(expect.display().to_string().as_str())
    );
}
