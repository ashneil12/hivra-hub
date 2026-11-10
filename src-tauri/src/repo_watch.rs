//! Project pin list (WP-166). The file is `.hivra/repo-pins.json` inside the
//! project. A missing file is an empty list. Two windows save with a revision,
//! so a stale write is refused and the caller reads again.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use serde_json::{json, Value};

use crate::portable::scrubber;

const MAX_BYTES: usize = 1_000_000;

fn gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

fn home_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?:/Users/|/home/)[^\s"'<>]+|[A-Za-z]:[/\\]Users[/\\][^\s"'<>]+"#).unwrap()
    })
}

fn hide_home(text: &str) -> String {
    home_re().replace_all(text, "a local path").into_owned()
}

fn hide_homes(value: &mut Value) {
    match value {
        Value::String(text) => *text = hide_home(text),
        Value::Array(items) => {
            for item in items {
                hide_homes(item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                hide_homes(item);
            }
        }
        _ => {}
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn canonical_dir(project: &Path) -> Result<PathBuf, String> {
    if project.as_os_str().is_empty() {
        return Err("That folder is not a project.".into());
    }
    let canon =
        crate::fs::canonical(project).map_err(|_| "That folder is not a project.".to_string())?;
    if !canon.is_dir() || canon.parent().is_none() {
        return Err("That folder is not a project.".into());
    }
    Ok(canon)
}

/// The pin file, after proving it cannot leave the project. A link is refused.
pub fn pins_path(project: &Path) -> Result<PathBuf, String> {
    let root = canonical_dir(project)?;
    let folder = root.join(".hivra");
    if is_symlink(&folder) {
        let target = crate::fs::canonical(&folder)
            .map_err(|_| "The pin folder is not inside the project.".to_string())?;
        if !target.starts_with(&root) {
            return Err("The pin folder is not inside the project.".into());
        }
    }
    let file = folder.join("repo-pins.json");
    if is_symlink(&file) {
        return Err("The pin file is a link. It was left alone.".into());
    }
    if !file.starts_with(&root) {
        return Err("The pin file is not inside the project.".into());
    }
    Ok(file)
}

fn empty_doc(revision: u64) -> String {
    format!("{{\"revision\":{revision},\"enqueueDrafts\":false,\"pins\":[]}}\n")
}

fn read_revision(text: &str) -> u64 {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return value.get("revision").and_then(Value::as_u64).unwrap_or(0);
    }
    // A half-written file still names its revision, so the next save is not stuck at 0.
    static RE: OnceLock<Regex> = OnceLock::new();
    let revision = RE.get_or_init(|| Regex::new(r#""revision"\s*:\s*(\d+)"#).unwrap());
    revision
        .captures(text)
        .and_then(|cap| cap.get(1))
        .and_then(|found| found.as_str().parse().ok())
        .unwrap_or(0)
}

fn prepare(body: &str, revision: u64) -> Result<Vec<u8>, String> {
    if body.len() > MAX_BYTES {
        return Err("That pin list is too large.".into());
    }
    let mut value: Value =
        serde_json::from_str(body).map_err(|_| "That pin list could not be read.".to_string())?;
    if !value.is_object() {
        return Err("That pin list could not be read.".into());
    }
    scrubber().redact_value(&mut value);
    hide_homes(&mut value);
    let Some(map) = value.as_object_mut() else {
        return Err("That pin list could not be read.".into());
    };
    map.insert("revision".into(), json!(revision));
    if map.get("enqueueDrafts").and_then(Value::as_bool) != Some(true) {
        map.insert("enqueueDrafts".into(), json!(false));
    }
    if !map.get("pins").is_some_and(Value::is_array) {
        map.insert("pins".into(), json!([]));
    }
    let mut bytes = serde_json::to_vec_pretty(&value)
        .map_err(|_| "Could not save the pin list.".to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn load(project: &Path) -> Result<String, String> {
    let _hold = gate().lock().unwrap_or_else(|error| error.into_inner());
    let path = pins_path(project)?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(empty_doc(0)),
        Err(_) => return Err("Could not read the pin list.".into()),
    };
    let revision = read_revision(&text);
    match prepare(&text, revision) {
        Ok(bytes) => {
            String::from_utf8(bytes).map_err(|_| "Could not read the pin list.".to_string())
        }
        Err(_) => Ok(empty_doc(revision)),
    }
}

pub fn cas(project: &Path, expected: u64, body: &str) -> Result<bool, String> {
    let _hold = gate().lock().unwrap_or_else(|error| error.into_inner());
    let path = pins_path(project)?;
    let current = match fs::read_to_string(&path) {
        Ok(text) => read_revision(&text),
        Err(error) if error.kind() == ErrorKind::NotFound => 0,
        Err(_) => return Err("Could not read the pin list.".into()),
    };
    if current != expected {
        return Ok(false);
    }
    let bytes = prepare(body, expected.saturating_add(1))?;
    atomic_write(&path, &bytes)?;
    Ok(true)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("Could not save the pin list.".into());
    };
    if is_symlink(parent) {
        return Err("The pin folder is a link. It was left alone.".into());
    }
    fs::create_dir_all(parent).map_err(|_| "Could not save the pin list.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    if tmp.parent() != Some(parent) || is_symlink(&tmp) {
        return Err("Could not save the pin list.".into());
    }
    if let Err(error) = fs::write(&tmp, bytes) {
        let _ = remove_inside(parent, &tmp);
        return Err(if error.kind() == ErrorKind::TimedOut {
            "Could not save the pin list this time.".into()
        } else {
            "Could not save the pin list.".into()
        });
    }
    replace_file(&tmp, path)
}

fn remove_inside(parent: &Path, path: &Path) -> Result<(), ()> {
    if path.parent() != Some(parent) || is_symlink(path) {
        return Err(());
    }
    fs::remove_file(path).map_err(|_| ())
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    let Some(parent) = to.parent() else {
        return Err("Could not save the pin list.".into());
    };
    if from.parent() != Some(parent) {
        return Err("Could not save the pin list.".into());
    }
    if !to.exists() {
        return fs::rename(from, to).map_err(|_| "Could not save the pin list.".to_string());
    }
    let backup = to.with_extension("json.bak");
    if backup.parent() != Some(parent) {
        return Err("Could not save the pin list.".into());
    }
    if backup.exists() && !is_symlink(&backup) {
        let _ = fs::remove_file(&backup);
    }
    fs::rename(to, &backup).map_err(|_| "Could not save the pin list.".to_string())?;
    match fs::rename(from, to) {
        Ok(()) => {
            if !is_symlink(&backup) {
                let _ = fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(_) => {
            if !to.exists() && !is_symlink(&backup) {
                let _ = fs::rename(&backup, to);
            }
            Err("Could not save the pin list.".into())
        }
    }
}

#[tauri::command(async)]
pub fn repo_watch_load(project: String) -> Result<String, String> {
    load(Path::new(&project))
}

#[tauri::command(async)]
pub fn repo_watch_cas(project: String, expected: u64, body: String) -> Result<bool, String> {
    cas(Path::new(&project), expected, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Tmp {
        path: PathBuf,
    }

    impl Tmp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "hivra-wp166-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    const PLANTED: &str = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";

    #[test]
    fn a_missing_file_is_an_empty_list() {
        let tmp = Tmp::new();
        let project = tmp.path.join("My Project");
        fs::create_dir_all(&project).unwrap();
        let text = load(&project).unwrap();
        assert!(text.contains("\"pins\": []") || text.contains("\"pins\":[]"));
        assert!(text.contains("\"revision\": 0") || text.contains("\"revision\":0"));
        assert!(!project.join(".hivra").exists());
        assert!(!text.contains(&tmp.path.display().to_string()));
    }

    #[test]
    fn the_second_window_does_not_overwrite() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        let body = r#"{"enqueueDrafts":false,"pins":[{"url":"https://github.com/acme/web","licence":"MIT","pinSha":"abc1234","notes":"door"}]}"#;
        assert!(cas(&project, 0, body).unwrap());
        assert!(!cas(&project, 0, body).unwrap());
        assert!(cas(&project, 1, body).unwrap());
        let text = fs::read_to_string(project.join(".hivra").join("repo-pins.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["revision"], 2);
        assert_eq!(value["pins"][0]["url"], "https://github.com/acme/web");
    }

    #[test]
    fn a_token_and_a_home_path_are_not_stored() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        let body = format!(
            r#"{{"pins":[{{"url":"https://github.com/acme/web","notes":"see {PLANTED} /Users/example/notes"}}]}}"#
        );
        assert!(cas(&project, 0, &body).unwrap());
        let text = fs::read_to_string(project.join(".hivra").join("repo-pins.json")).unwrap();
        assert!(!text.contains(PLANTED));
        assert!(!text.contains("/Users/example"));
        assert!(text.contains("[secret removed]"));
        assert!(text.contains("a local path"));
    }

    #[test]
    fn only_a_real_true_keeps_drafts() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        assert!(cas(&project, 0, r#"{"enqueueDrafts":"yes","pins":[]}"#).unwrap());
        let off = fs::read_to_string(project.join(".hivra").join("repo-pins.json")).unwrap();
        assert!(off.contains("\"enqueueDrafts\": false"));
        assert!(cas(&project, 1, r#"{"enqueueDrafts":true,"pins":[]}"#).unwrap());
        let on = fs::read_to_string(project.join(".hivra").join("repo-pins.json")).unwrap();
        assert!(on.contains("\"enqueueDrafts\": true"));
    }

    #[test]
    fn load_does_not_rewrite_the_file() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        let body = r#"{"pins":[{"url":"https://github.com/acme/web","licence":"MIT","pinSha":"abc1234","notes":""}]}"#;
        assert!(cas(&project, 0, body).unwrap());
        let path = project.join(".hivra").join("repo-pins.json");
        let before = fs::read(&path).unwrap();
        let shown = load(&project).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(shown.contains("acme/web"));
    }

    #[test]
    fn a_broken_file_keeps_its_revision_and_drops_the_rows() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        let folder = project.join(".hivra");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("repo-pins.json"), "{\"revision\":4,\"pins\":").unwrap();
        let text = load(&project).unwrap();
        assert!(text.contains('4'));
        assert!(text.contains("[]"));
    }

    #[test]
    fn a_path_that_is_not_a_folder_is_refused() {
        let tmp = Tmp::new();
        let file = tmp.path.join("not-a-dir");
        fs::write(&file, "x").unwrap();
        let err = cas(&file, 0, r#"{"pins":[]}"#).unwrap_err();
        assert_eq!(err, "That folder is not a project.");
        assert!(!err.contains(&tmp.path.display().to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_outside_the_project_is_not_written() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        let outside = tmp.path.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, project.join(".hivra")).unwrap();
        let err = cas(&project, 0, r#"{"pins":[]}"#).unwrap_err();
        assert!(err.contains("not inside"));
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_skips_the_symlink_case() {
        // Creating a symlink here needs extra privileges. The path jail still
        // refuses a folder that is not a project, which is covered above.
    }
}
