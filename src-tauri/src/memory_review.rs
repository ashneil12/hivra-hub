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

/// WP-92: the plain compare-and-swap the app's command now reaches through `cas_checked`; kept for the tests that
/// exercise the store without a vault.
#[cfg(test)]
pub fn cas(dir: &Path, expected: u64, doc: Value) -> Result<bool, String> {
    cas_checked(dir, expected, doc, &|_| false)
}

/// WP-92: the same save, with one more gate: text that holds a saved key's value, whatever its shape, is refused.
pub fn cas_checked(
    dir: &Path,
    expected: u64,
    doc: Value,
    holds_value: &dyn Fn(&str) -> bool,
) -> Result<bool, String> {
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
    if mentions_secret(&text) || holds_value(&text) {
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
    // A link at the temp path would be followed by File::create and would
    // overwrite whatever it points at. Remove the link itself first.
    if is_symlink(&tmp) {
        if !parent_inside(dir, &tmp) {
            return Err("Couldn't save memory.".to_string());
        }
        fs::remove_file(&tmp).map_err(|_| "Couldn't save memory.".to_string())?;
        if is_symlink(&tmp) {
            return Err("Couldn't save memory.".to_string());
        }
    }
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
pub fn memory_review_cas(
    app: AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    revision: u64,
    doc: Value,
) -> Result<bool, String> {
    let dir = store_dir(&app)?;
    // WP-92: a value of any shape is refused, not only one that looks like a key.
    let holds = known_value_check(&store, crate::secrets::store::active())?;
    cas_checked(&dir, revision, doc, &holds)
}

/// WP-92: the check that refuses a note holding a saved value. The names come from the database under the store's lock,
/// which is let go before the Keychain is read: a system prompt left open must not stall every writer in the app.
pub(crate) fn known_value_check(
    store: &crate::session_store::SessionStore,
    vault: &dyn crate::secrets::Vault,
) -> Result<impl Fn(&str) -> bool, String> {
    let names = {
        let conn = store.lock_conn()?;
        crate::secrets::known_names(&conn, None)
    };
    let needles = crate::secrets::needles_for(vault, &names)?;
    Ok(move |text: &str| {
        needles
            .iter()
            .any(|needle| crate::secrets::scrub::holds(text, needle))
    })
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
    fn wp92_a_value_of_any_shape_is_refused_and_the_previous_file_stays() {
        let tmp = Tmp::new();
        assert!(cas_checked(&tmp.path, 0, json!({"items": []}), &|_| false).unwrap());
        let before = fs::read_to_string(tmp.path.join("doc.json")).unwrap();
        let value = "plain words nobody would call a key";
        let held = |text: &str| text.contains(value);
        let err = cas_checked(&tmp.path, 1, json!({"items": [value]}), &held).unwrap_err();
        assert_eq!(
            err,
            "That memory looks like it contains a secret, so it was not saved."
        );
        assert!(!err.contains(value));
        assert_eq!(
            fs::read_to_string(tmp.path.join("doc.json")).unwrap(),
            before
        );
        assert!(cas_checked(&tmp.path, 1, json!({"items": ["a note"]}), &held).unwrap());
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

    #[cfg(unix)]
    #[test]
    fn a_symlink_temp_file_is_not_followed() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let outside = tmp.path.join("outside.json");
        let marker = "keep-these-bytes";
        fs::write(&outside, marker).unwrap();
        let dir = tmp.path.join("memory");
        fs::create_dir(&dir).unwrap();
        symlink(&outside, dir.join("doc.json.tmp")).unwrap();
        assert!(cas(&dir, 0, json!({"items": []})).unwrap());
        assert_eq!(fs::read_to_string(&outside).unwrap(), marker);
        let doc = dir.join("doc.json");
        assert!(doc.is_file());
        assert!(!is_symlink(&doc));
        assert!(fs::read_to_string(&doc)
            .unwrap()
            .contains("\"revision\": 1"));
    }

    // ---- WP-92 fix round 1, item M: the Keychain is read with the store's lock free ---------------------------------------

    /// A store that, on every read, asks whether the database lock is free (another thread takes it) and records it.
    struct Probe {
        inner: crate::secrets::store::Memory,
        store: std::sync::Arc<crate::session_store::SessionStore>,
        free: std::sync::Mutex<Vec<bool>>,
    }

    impl crate::secrets::Vault for Probe {
        fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            let store = self.store.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _guard = store.lock_conn();
                let _ = tx.send(());
            });
            let free = rx
                .recv_timeout(std::time::Duration::from_millis(1_500))
                .is_ok();
            self.free.lock().unwrap().push(free);
            self.inner.read(service, account)
        }

        fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
            self.inner.write(service, account, value)
        }

        fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
            self.inner.remove(service, account)
        }
    }

    #[test]
    fn a_note_check_reads_the_keychain_with_the_database_lock_free_and_still_refuses_a_saved_value()
    {
        let store =
            std::sync::Arc::new(crate::session_store::SessionStore::open_in_memory().unwrap());
        let probe = Probe {
            inner: crate::secrets::store::Memory::new(),
            store: store.clone(),
            free: std::sync::Mutex::new(Vec::new()),
        };
        {
            let conn = store.lock_conn().unwrap();
            for (name, value) in [
                ("stripe-api-key", "sk_live_51NxAbCdEfGhIjKl"),
                ("resend-key", "re_live_abcdef012345"),
            ] {
                crate::secrets::save_value(
                    &probe,
                    &conn,
                    crate::secrets::SCOPE_GLOBAL,
                    name,
                    None,
                    value,
                    1,
                )
                .unwrap();
            }
        }
        probe.free.lock().unwrap().clear();
        let holds = known_value_check(&store, &probe).unwrap();
        // Two values were read, and the lock was free for both.
        assert_eq!(*probe.free.lock().unwrap(), vec![true, true]);
        assert!(holds(
            "a note that mentions sk_live_51NxAbCdEfGhIjKl in passing"
        ));
        assert!(!holds("a note about something else"));
    }
}
