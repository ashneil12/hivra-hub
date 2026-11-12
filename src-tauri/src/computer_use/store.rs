//! Where computer use keeps its settings and its activity log, and how it finds the sidecar (WP-255).
//!
//! Both files sit in the app's data folder: `computer-use.json` (Settings > Computer use) and
//! `computer-use-activity.jsonl` (one line per call, allowed or refused). The proxy (`monocode computer-use`) reads the
//! settings again before every call, so turning computer use off holds at once, mid-turn included.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::policy::Settings;

pub const SETTINGS_FILE: &str = "computer-use.json";
pub const ACTIVITY_FILE: &str = "computer-use-activity.jsonl";
/// The log is cut over to `.1` past this size; one older file is kept.
const ACTIVITY_MAX_BYTES: u64 = 1_000_000;
/// The sidecar's program, from npm's `open-computer-use` package (MIT, iFurySt/open-computer-use).
pub const SIDECAR_PROGRAM: &str = "open-computer-use";

pub fn settings_path(data: &Path) -> PathBuf {
    data.join(SETTINGS_FILE)
}

pub fn activity_path(settings: &Path) -> PathBuf {
    settings.with_file_name(ACTIVITY_FILE)
}

/// The settings, or all off when the file is missing, unreadable or not what it should be.
pub fn read(path: &Path) -> Settings {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn write(path: &Path, settings: &Settings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub at: u64,
    pub chat: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub app: String,
    pub detail: String,
    pub allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Adds one line. A log that can't be written never stops the call it records.
pub fn append(path: &Path, entry: &Activity) {
    if fs::metadata(path)
        .map(|m| m.len() > ACTIVITY_MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::rename(path, path.with_extension("jsonl.1"));
    }
    let Ok(line) = serde_json::to_string(entry) else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// The newest `limit` entries, newest first.
pub fn recent(path: &Path, limit: usize) -> Vec<Activity> {
    let text = fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .rev()
        .filter_map(|line| serde_json::from_str(line).ok())
        .take(limit)
        .collect()
}

/// The folders a Mac keeps command-line tools in when the app's own PATH is short (an app opened from the Dock).
fn extra_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home {
        for rel in [".npm-global/bin", ".local/bin", ".volta/bin", ".bun/bin"] {
            dirs.push(home.join(rel));
        }
    }
    dirs
}

/// The sidecar: the one Settings chose if it is still there, else the first `open-computer-use` on PATH or in the
/// usual folders.
pub fn find_sidecar(
    chosen: Option<&str>,
    path_var: Option<&str>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(chosen) = chosen.map(str::trim).filter(|c| !c.is_empty()) {
        let chosen = PathBuf::from(chosen);
        return chosen
            .is_absolute()
            .then_some(chosen)
            .filter(|p| p.is_file());
    }
    let mut dirs: Vec<PathBuf> = path_var
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    dirs.extend(extra_dirs(home));
    dirs.into_iter()
        .map(|dir| dir.join(SIDECAR_PROGRAM))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer_use::policy::{ChatMode, Mode};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("hivra-wp255-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    #[test]
    fn a_missing_or_broken_file_is_all_off() {
        let dir = tempdir();
        let path = settings_path(dir.path());
        assert_eq!(read(&path), Settings::default());
        fs::write(&path, "{ not json").unwrap();
        assert!(!read(&path).enabled);
        fs::write(&path, r#"{"enabled": "yes"}"#).unwrap();
        assert!(!read(&path).enabled);
    }

    #[test]
    fn settings_round_trip() {
        let dir = tempdir();
        let path = settings_path(dir.path());
        let mut settings = Settings {
            enabled: true,
            mode: Mode::Control,
            ..Settings::default()
        };
        settings.chats.insert("c".into(), ChatMode::Deny);
        write(&path, &settings).unwrap();
        assert_eq!(read(&path), settings);
    }

    #[test]
    fn the_log_keeps_the_newest_first_and_rolls_over() {
        let dir = tempdir();
        let path = activity_path(&settings_path(dir.path()));
        for at in 0..3 {
            append(
                &path,
                &Activity {
                    at,
                    chat: "c".into(),
                    tool: "computer_click".into(),
                    app: "Notes".into(),
                    detail: "click".into(),
                    allowed: true,
                    reason: None,
                },
            );
        }
        let got = recent(&path, 2);
        assert_eq!(got.iter().map(|a| a.at).collect::<Vec<_>>(), vec![2, 1]);
        fs::write(&path, vec![b'x'; (ACTIVITY_MAX_BYTES + 1) as usize]).unwrap();
        append(&path, &got[0]);
        assert_eq!(recent(&path, 10).len(), 1);
        assert!(path.with_extension("jsonl.1").exists());
    }

    #[test]
    fn the_sidecar_is_found_on_path_or_where_chosen() {
        let dir = tempdir();
        let bin = dir.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let program = bin.join(SIDECAR_PROGRAM);
        assert_eq!(find_sidecar(None, bin.to_str(), None), None);
        fs::write(&program, "").unwrap();
        assert_eq!(
            find_sidecar(None, bin.to_str(), None),
            Some(program.clone())
        );
        assert_eq!(
            find_sidecar(program.to_str(), None, None),
            Some(program.clone())
        );
        // A chosen program that is gone, or a relative one, is never swapped for another.
        assert_eq!(find_sidecar(Some("/nowhere/ocu"), bin.to_str(), None), None);
        assert_eq!(find_sidecar(Some("ocu"), bin.to_str(), None), None);
    }
}
