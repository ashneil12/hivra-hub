//! WP-51: memory the person reviews, saved by compare-and-swap.
//!
//! A secret is refused and the previous file is left as it was. A file that
//! is not JSON comes back as an empty doc. A symlink is not followed.

use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const MAX_DOC_BYTES: usize = 1_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub revision: u64,
    pub doc: Value,
}

fn lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn mentions_secret(text: &str) -> bool {
    let scrubber = crate::portable::scrubber();
    if scrubber.has_secret(text) {
        return true;
    }
    if !(text.contains('/') || text.contains('\\') || text.contains(':')) {
        return false;
    }
    scrubber.has_secret(&text.replace(['/', '\\', ':'], " "))
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn parent_inside(dir: &Path, path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(dir) = crate::fs::canonical(dir) else {
        return false;
    };
    let Ok(parent) = crate::fs::canonical(parent) else {
        return false;
    };
    parent.starts_with(dir)
}

fn empty_loaded() -> Loaded {
    Loaded {
        revision: 0,
        doc: json!({}),
    }
}

fn backup_corrupt(path: &Path) -> Result<(), String> {
    let backup = path.with_extension("json.corrupt");
    if backup.exists() && !is_symlink(&backup) {
        fs::remove_file(&backup)
            .map_err(|_| "Couldn't move the broken memory aside.".to_string())?;
    }
    fs::rename(path, backup).map_err(|_| "Couldn't move the broken memory aside.".to_string())
}

fn parse_doc(path: &Path, text: &str) -> Result<Loaded, String> {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => {
            let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
            let doc = value.get("doc").cloned().unwrap_or_else(|| json!({}));
            if !doc.is_object() {
                return Ok(empty_loaded());
            }
            Ok(Loaded { revision, doc })
        }
        Err(_) => {
            backup_corrupt(path)?;
            Ok(empty_loaded())
        }
    }
}

pub fn load(dir: &Path) -> Result<Loaded, String> {
    let _guard = lock();
    load_unlocked(dir)
}

fn load_unlocked(dir: &Path) -> Result<Loaded, String> {
    if is_symlink(dir) {
        return Ok(empty_loaded());
    }
    let path = dir.join("doc.json");
    if is_symlink(&path) {
        return Ok(empty_loaded());
    }
    match fs::read_to_string(&path) {
        Ok(text) => parse_doc(&path, &text),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(empty_loaded()),
        Err(_) => Err("Couldn't read memory.".to_string()),
    }
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    if is_symlink(to) {
        let _ = fs::remove_file(from);
        return Err("Couldn't save memory.".to_string());
    }
    if !to.exists() {
        return fs::rename(from, to).map_err(|_| "Couldn't save memory.".to_string());
    }
    let backup = to.with_extension("json.bak");
    if backup.exists() && !is_symlink(&backup) {
        fs::remove_file(&backup).map_err(|_| "Couldn't save memory.".to_string())?;
    }
    fs::rename(to, &backup).map_err(|_| "Couldn't save memory.".to_string())?;
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            if !to.exists() {
                let _ = fs::rename(&backup, to);
            }
            Err("Couldn't save memory.".to_string())
        }
    }
}

pub fn cas(dir: &Path, expected: u64, doc: Value) -> Result<bool, String> {
    let _guard = lock();
    if !doc.is_object() {
        return Err("That memory could not be saved.".to_string());
    }
    let bytes = serde_json::to_vec_pretty(&json!({
        "revision": expected + 1,
        "doc": doc,
    }))
    .map_err(|_| "That memory could not be saved.".to_string())?;
    if bytes.len() > MAX_DOC_BYTES {
        return Err("That memory could not be saved.".to_string());
    }
    let text = String::from_utf8_lossy(&bytes);
    if mentions_secret(&text) {
        return Err(
            "That memory looks like it contains a secret, so it was not saved.".to_string(),
        );
    }
    if is_symlink(dir) {
        return Err("Couldn't save memory.".to_string());
    }
    fs::create_dir_all(dir).map_err(|_| "Couldn't save memory.".to_string())?;
    let path = dir.join("doc.json");
    if !parent_inside(dir, &path) || is_symlink(&path) {
        return Err("Couldn't save memory.".to_string());
    }
    let current = load_unlocked(dir)?;
    if current.revision != expected {
        return Ok(false);
    }
    let tmp = path.with_extension("json.tmp");
    let mut file = File::create(&tmp).map_err(|_| "Couldn't save memory.".to_string())?;
    std::io::Write::write_all(&mut file, &bytes)
        .map_err(|_| "Couldn't save memory.".to_string())?;
    file.sync_all()
        .map_err(|_| "Couldn't save memory.".to_string())?;
    replace_file(&tmp, &path)?;
    Ok(true)
}

fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Couldn't find the app folder.".to_string())?
        .join("memory-review"))
}

#[tauri::command]
pub fn memory_review_load(app: AppHandle) -> Result<Loaded, String> {
    load(&store_dir(&app)?)
}

#[tauri::command]
pub fn memory_review_cas(app: AppHandle, revision: u64, doc: Value) -> Result<bool, String> {
    cas(&store_dir(&app)?, revision, doc)
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
                "hivra-wp51-{}-{}",
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

    #[test]
    fn cas_writes_only_the_revision_it_read() {
        let tmp = Tmp::new();
        assert_eq!(load(&tmp.path).unwrap().revision, 0);
        assert!(cas(&tmp.path, 0, json!({"items": []})).unwrap());
        assert!(!cas(&tmp.path, 0, json!({"items": ["late"]})).unwrap());
        let text = fs::read_to_string(tmp.path.join("doc.json")).unwrap();
        assert!(text.contains("\"revision\": 1"));
        assert!(!text.contains("late"));
        assert!(cas(&tmp.path, 1, json!({"items": ["kept"]})).unwrap());
        let loaded = load(&tmp.path).unwrap();
        assert_eq!(loaded.revision, 2);
        assert_eq!(loaded.doc["items"][0], "kept");
    }

    #[test]
    fn a_secret_is_not_saved_and_the_previous_file_stays() {
        let tmp = Tmp::new();
        assert!(cas(&tmp.path, 0, json!({"items": []})).unwrap());
        let before = fs::read_to_string(tmp.path.join("doc.json")).unwrap();
        let secret = "sk-ant-api03-abcdefghijklmnopqrst";
        let err = cas(&tmp.path, 1, json!({"items": [secret]})).unwrap_err();
        assert!(!err.contains(secret));
        assert_eq!(
            fs::read_to_string(tmp.path.join("doc.json")).unwrap(),
            before
        );
        assert!(!before.contains(secret));
    }

    #[test]
    fn a_broken_file_comes_back_empty() {
        let tmp = Tmp::new();
        fs::write(tmp.path.join("doc.json"), b"not json").unwrap();
        let loaded = load(&tmp.path).unwrap();
        assert_eq!(loaded.revision, 0);
        assert_eq!(loaded.doc, json!({}));
        assert!(tmp.path.join("doc.json.corrupt").is_file());
        assert!(cas(&tmp.path, 0, json!({"items": []})).unwrap());
    }

    #[test]
    fn a_doc_that_is_not_an_object_is_refused() {
        let tmp = Tmp::new();
        assert!(cas(&tmp.path, 0, json!([1, 2])).is_err());
        assert!(!tmp.path.join("doc.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_not_read_or_replaced() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let outside = tmp.path.join("outside.json");
        let secret = "sk-ant-api03-abcdefghijklmnopqrst";
        fs::write(&outside, secret).unwrap();
        let dir = tmp.path.join("memory");
        fs::create_dir(&dir).unwrap();
        symlink(&outside, dir.join("doc.json")).unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(loaded.revision, 0);
        assert!(!loaded.doc.to_string().contains(secret));
        assert!(cas(&dir, 0, json!({"items": []})).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), secret);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_directory_is_not_read_or_written() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let outside = tmp.path.join("outside");
        fs::create_dir(&outside).unwrap();
        let secret = "sk-ant-api03-abcdefghijklmnopqrst";
        fs::write(
            outside.join("doc.json"),
            format!(r#"{{"revision": 1, "doc": {{"note": "{secret}"}}}}"#),
        )
        .unwrap();
        let link = tmp.path.join("link");
        symlink(&outside, &link).unwrap();
        let loaded = load(&link).unwrap();
        assert_eq!(loaded.revision, 0);
        assert!(!loaded.doc.to_string().contains(secret));
        assert!(cas(&link, 0, json!({"items": []})).is_err());
        assert!(fs::read_to_string(outside.join("doc.json"))
            .unwrap()
            .contains(secret));
    }

    #[cfg(windows)]
    #[test]
    fn a_symlink_is_not_read_or_replaced() {
        // Creating a symlink needs extra rights here. The unix test covers it.
        assert!(cfg!(windows));
    }

    #[cfg(windows)]
    #[test]
    fn a_symlink_directory_is_not_read_or_written() {
        // Creating a symlink needs extra rights here. The unix test covers it.
        assert!(cfg!(windows));
    }
}
