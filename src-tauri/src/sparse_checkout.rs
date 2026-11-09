//! WP-118: the per-project switch for a sparse checkout on the next new worktree.
//!
//! Missing, empty and unreadable settings stay off. Only projects that are on are
//! stored. A second window has to send the value it last saw; a stale write is
//! refused and the file is left as it was. Nothing here downloads gion or runs an
//! installer. The pin stays unset until a release asset is checksummed.

use std::collections::BTreeSet;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const DIR_NAME: &str = "sparse-checkout";
const FILE_NAME: &str = "settings.json";
const LOCK_NAME: &str = ".sparse-checkout.lock";
const LOCK_WAIT: Duration = Duration::from_millis(1500);
const LOCK_STALE: Duration = Duration::from_secs(30);

pub const NOT_FOUND: &str = "This project folder can't be found.";
pub const CONFLICT: &str = "This setting changed in another window. Look again, then change it.";
pub const UNREADABLE: &str = "The saved setting can't be read. Nothing was changed.";
pub const LINK_REFUSED: &str = "The sparse checkout setting is a link, so it was refused.";
pub const OUTSIDE: &str = "Refusing to write the sparse checkout setting outside its folder.";
pub const BUSY: &str = "This setting is busy in another window. Try again.";
pub const CANT_SAVE: &str = "The sparse checkout setting can't be saved.";

/// Where this copy of the app keeps its own settings. A dev copy has its own data folder.
pub struct SparseEnv {
    pub data_dir: PathBuf,
}

pub fn env_from_app(app: &AppHandle) -> SparseEnv {
    let data_dir = crate::project_file::data_dir(app).unwrap_or_else(|_| {
        std::env::temp_dir().join(format!(
            "monocode-hub-sparse-checkout-{}",
            std::process::id()
        ))
    });
    SparseEnv { data_dir }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SparseSettings {
    pub enabled: bool,
    /// False when the file is there but isn't usable JSON. The switch still reads as off.
    pub readable: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileBody {
    enabled: BTreeSet<String>,
}

enum Saved {
    Missing,
    Ready(BTreeSet<String>),
    Unreadable,
}

struct Place {
    data: PathBuf,
    state: PathBuf,
    file: PathBuf,
    lock_path: PathBuf,
}

/// True only when this project was saved as on. Any problem reading the file is off,
/// so a bad file cannot turn a new worktree sparse. The new-worktree path calls this;
/// until that lands, only the tests do.
#[allow(dead_code)]
pub fn enabled_for(env: &SparseEnv, repo: &Path) -> bool {
    let Ok(key) = project_key(repo) else {
        return false;
    };
    let Ok(place) = place(env) else {
        return false;
    };
    match load(&place) {
        Ok(Saved::Ready(keys)) => keys.contains(&key),
        _ => false,
    }
}

pub fn settings_for(env: &SparseEnv, repo: &Path) -> Result<SparseSettings, String> {
    let key = project_key(repo)?;
    let place = place(env)?;
    match load(&place)? {
        Saved::Missing => Ok(view(false, true)),
        Saved::Ready(keys) => Ok(view(keys.contains(&key), true)),
        Saved::Unreadable => Ok(view(false, false)),
    }
}

/// `previous` is the on/off value the caller last read for this project. The file
/// changes only when that still matches. The same value again does not rewrite it.
pub fn set_enabled(
    env: &SparseEnv,
    repo: &Path,
    enabled: bool,
    previous: bool,
) -> Result<SparseSettings, String> {
    let key = project_key(repo)?;
    let place = place(env)?;
    let _lock = Lock::acquire(&place)?;
    apply(&place, &key, enabled, previous)
}

fn apply(
    place: &Place,
    key: &str,
    enabled: bool,
    previous: bool,
) -> Result<SparseSettings, String> {
    let saved = load(place)?;
    let current = match &saved {
        Saved::Missing => false,
        Saved::Ready(keys) => keys.contains(key),
        Saved::Unreadable => {
            if previous {
                return Err(UNREADABLE.to_string());
            }
            false
        }
    };
    if current != previous {
        return Err(CONFLICT.to_string());
    }
    if current == enabled {
        let readable = !matches!(saved, Saved::Unreadable);
        return Ok(view(enabled, readable));
    }
    let mut keys = match saved {
        Saved::Ready(keys) => keys,
        _ => BTreeSet::new(),
    };
    if enabled {
        keys.insert(key.to_string());
        create_state(place)?;
        write_file(place, &keys)?;
    } else {
        keys.remove(key);
        if keys.is_empty() {
            remove_settings(place)?;
        } else {
            create_state(place)?;
            write_file(place, &keys)?;
        }
    }
    Ok(view(enabled, true))
}

fn view(enabled: bool, readable: bool) -> SparseSettings {
    SparseSettings { enabled, readable }
}

fn project_key(path: &Path) -> Result<String, String> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(NOT_FOUND.to_string());
    }
    let canon = crate::fs::canonical(path).map_err(|_| NOT_FOUND.to_string())?;
    if !canon.is_dir() {
        return Err(NOT_FOUND.to_string());
    }
    canon
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| NOT_FOUND.to_string())
}

fn place(env: &SparseEnv) -> Result<Place, String> {
    let data = crate::fs::canonical(&env.data_dir).map_err(|_| CANT_SAVE.to_string())?;
    if !data.is_dir() {
        return Err(CANT_SAVE.to_string());
    }
    let state = data.join(DIR_NAME);
    Ok(Place {
        file: state.join(FILE_NAME),
        lock_path: data.join(LOCK_NAME),
        data,
        state,
    })
}

fn is_link(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        junction::exists(path).unwrap_or(false)
    }
    #[cfg(not(windows))]
    false
}

fn ensure_state(place: &Place) -> Result<(), String> {
    if is_link(&place.state) || is_link(&place.file) || is_link(&place.lock_path) {
        return Err(LINK_REFUSED.to_string());
    }
    if place.state.exists() {
        state_is_inside(place)?;
    }
    Ok(())
}

fn state_is_inside(place: &Place) -> Result<(), String> {
    let real = crate::fs::canonical(&place.state).map_err(|_| OUTSIDE.to_string())?;
    if real.parent() != Some(place.data.as_path()) || real.file_name() != Some(DIR_NAME.as_ref()) {
        return Err(OUTSIDE.to_string());
    }
    Ok(())
}

fn create_state(place: &Place) -> Result<(), String> {
    ensure_state(place)?;
    if place.state.exists() {
        if !place.state.is_dir() {
            return Err(CANT_SAVE.to_string());
        }
        return Ok(());
    }
    std::fs::create_dir(&place.state).map_err(|_| CANT_SAVE.to_string())?;
    if is_link(&place.state) {
        return Err(LINK_REFUSED.to_string());
    }
    state_is_inside(place)
}

fn load(place: &Place) -> Result<Saved, String> {
    ensure_state(place)?;
    if is_link(&place.file) {
        return Err(LINK_REFUSED.to_string());
    }
    if !place.file.exists() {
        return Ok(Saved::Missing);
    }
    let bytes = match std::fs::read(&place.file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Saved::Missing),
        Err(_) => return Ok(Saved::Unreadable),
    };
    match serde_json::from_slice::<FileBody>(&bytes) {
        Ok(body) => Ok(Saved::Ready(body.enabled)),
        Err(_) => Ok(Saved::Unreadable),
    }
}

fn encode(keys: &BTreeSet<String>) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(&FileBody {
        enabled: keys.clone(),
    })
    .map_err(|_| CANT_SAVE.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn inside_state(place: &Place, path: &Path) -> bool {
    let Ok(real) = crate::fs::canonical(path) else {
        return false;
    };
    real.parent() == Some(place.state.as_path())
}

fn write_file(place: &Place, keys: &BTreeSet<String>) -> Result<(), String> {
    if is_link(&place.state) || is_link(&place.file) {
        return Err(LINK_REFUSED.to_string());
    }
    state_is_inside(place)?;
    let bytes = encode(keys)?;
    if std::fs::read(&place.file).ok().as_ref() == Some(&bytes) {
        return Ok(());
    }
    let part = place
        .state
        .join(format!(".settings.{}.part", std::process::id()));
    if part.parent() != Some(place.state.as_path()) || is_link(&part) {
        return Err(OUTSIDE.to_string());
    }
    if part.exists() {
        if !inside_state(place, &part) {
            return Err(OUTSIDE.to_string());
        }
        std::fs::remove_file(&part).map_err(|_| CANT_SAVE.to_string())?;
    }
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .map_err(|_| CANT_SAVE.to_string())?;
        file.write_all(&bytes).map_err(|_| CANT_SAVE.to_string())?;
        file.sync_all().ok();
    }
    if !inside_state(place, &part) {
        return Err(OUTSIDE.to_string());
    }
    std::fs::rename(&part, &place.file).map_err(|error| {
        let _ = std::fs::remove_file(&part);
        error.to_string()
    })?;
    if is_link(&place.file) || !inside_state(place, &place.file) {
        return Err(OUTSIDE.to_string());
    }
    Ok(())
}

fn remove_settings(place: &Place) -> Result<(), String> {
    if is_link(&place.file) {
        return Err(LINK_REFUSED.to_string());
    }
    if !place.file.exists() {
        return Ok(());
    }
    if !inside_state(place, &place.file) {
        return Err(OUTSIDE.to_string());
    }
    std::fs::remove_file(&place.file).map_err(|_| CANT_SAVE.to_string())
}

struct Lock {
    path: PathBuf,
}

impl Lock {
    fn acquire(place: &Place) -> Result<Self, String> {
        if is_link(&place.lock_path) || is_link(&place.state) {
            return Err(LINK_REFUSED.to_string());
        }
        let deadline = std::time::Instant::now() + LOCK_WAIT;
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&place.lock_path)
            {
                Ok(_) => {
                    return Ok(Self {
                        path: place.lock_path.clone(),
                    })
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    if is_link(&place.lock_path) {
                        return Err(LINK_REFUSED.to_string());
                    }
                    if lock_is_stale(&place.lock_path) {
                        let _ = std::fs::remove_file(&place.lock_path);
                    } else if std::time::Instant::now() >= deadline {
                        return Err(BUSY.to_string());
                    } else {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
                Err(_) => return Err(CANT_SAVE.to_string()),
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn lock_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > LOCK_STALE)
}

#[tauri::command(async)]
pub async fn sparse_checkout_settings(
    app: AppHandle,
    cwd: String,
) -> Result<SparseSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings_for(&env_from_app(&app), &crate::fs::expand_home(&cwd))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn sparse_checkout_set(
    app: AppHandle,
    cwd: String,
    enabled: bool,
    previous: bool,
) -> Result<SparseSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_enabled(
            &env_from_app(&app),
            &crate::fs::expand_home(&cwd),
            enabled,
            previous,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Barrier};

    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "hivra-sparse-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn env(&self) -> SparseEnv {
            let data = self.root.join("data");
            std::fs::create_dir_all(&data).unwrap();
            SparseEnv { data_dir: data }
        }

        fn repo(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            remove_tree(&self.root);
        }
    }

    fn remove_tree(path: &Path) {
        if is_link(path) {
            let _ = std::fs::remove_file(path);
            return;
        }
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return;
        };
        if meta.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    remove_tree(&entry.path());
                }
            }
            let _ = std::fs::remove_dir(path);
        } else {
            let _ = std::fs::remove_file(path);
        }
    }

    fn settings_file(env: &SparseEnv) -> PathBuf {
        env.data_dir.join(DIR_NAME).join(FILE_NAME)
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) {
        junction::create(target, link).unwrap();
    }

    #[test]
    fn missing_file_reads_as_off_and_turning_off_creates_nothing() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        assert!(!enabled_for(&env, &repo));
        assert_eq!(settings_for(&env, &repo).unwrap(), view(false, true));
        set_enabled(&env, &repo, false, false).unwrap();
        assert!(!env.data_dir.join(DIR_NAME).exists());
        assert!(!settings_file(&env).exists());
        assert!(!env.data_dir.join(LOCK_NAME).exists());
    }

    #[test]
    fn turning_on_stores_only_that_project_and_the_same_value_does_not_rewrite() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo name");
        let nested = scratch.repo("repo name").join("项目");
        std::fs::create_dir_all(&nested).unwrap();
        set_enabled(&env, &repo, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
        assert!(!enabled_for(&env, &nested));
        let path = settings_file(&env);
        let before = std::fs::read(&path).unwrap();
        let stamp = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stamp)
            .unwrap();
        set_enabled(&env, &repo, true, true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), stamp);
    }

    #[test]
    fn dotted_paths_are_one_key_and_a_missing_folder_is_refused() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let via = repo.join("..").join("repo");
        set_enabled(&env, &via, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
        assert!(enabled_for(&env, &via));
        let missing = scratch.root.join("nope");
        let saved = std::fs::read(settings_file(&env)).unwrap();
        assert_eq!(
            set_enabled(&env, &missing, true, false).unwrap_err(),
            NOT_FOUND
        );
        assert_eq!(std::fs::read(settings_file(&env)).unwrap(), saved);
        let file = scratch.root.join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            set_enabled(&env, &file, true, false).unwrap_err(),
            NOT_FOUND
        );
        assert_eq!(
            set_enabled(&env, Path::new("repo"), true, false).unwrap_err(),
            NOT_FOUND
        );
        assert_eq!(
            set_enabled(&env, Path::new(""), true, false).unwrap_err(),
            NOT_FOUND
        );
    }

    #[test]
    fn a_stale_previous_does_not_overwrite_and_two_projects_do_not_clash() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let first = scratch.repo("one");
        let second = scratch.repo("two");
        set_enabled(&env, &first, true, false).unwrap();
        assert_eq!(
            set_enabled(&env, &first, false, false).unwrap_err(),
            CONFLICT
        );
        assert!(enabled_for(&env, &first));
        set_enabled(&env, &second, true, false).unwrap();
        assert!(enabled_for(&env, &first));
        assert!(enabled_for(&env, &second));
        set_enabled(&env, &first, false, true).unwrap();
        assert!(!enabled_for(&env, &first));
        assert!(enabled_for(&env, &second));
        assert!(settings_file(&env).exists());
        set_enabled(&env, &second, false, true).unwrap();
        assert!(!settings_file(&env).exists());
    }

    #[test]
    fn corrupt_json_reads_as_off_and_a_true_previous_leaves_the_bytes() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let dir = env.data_dir.join(DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, b"{").unwrap();
        assert!(!enabled_for(&env, &repo));
        assert_eq!(settings_for(&env, &repo).unwrap(), view(false, false));
        assert_eq!(
            set_enabled(&env, &repo, true, true).unwrap_err(),
            UNREADABLE
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        set_enabled(&env, &repo, false, false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        set_enabled(&env, &repo, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
        assert_eq!(settings_for(&env, &repo).unwrap(), view(true, true));
    }

    #[test]
    fn odd_files_read_as_off() {
        let cases: &[&[u8]] = &[
            b"",
            b"[]",
            br#"{"enabled":true}"#,
            br#"{"enabled":[],"extra":1}"#,
            b"not json",
        ];
        for bytes in cases {
            let scratch = Scratch::new();
            let env = scratch.env();
            let repo = scratch.repo("repo");
            let dir = env.data_dir.join(DIR_NAME);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(FILE_NAME), *bytes).unwrap();
            assert!(!enabled_for(&env, &repo), "{bytes:?}");
            assert!(!settings_for(&env, &repo).unwrap().readable);
        }
    }

    #[test]
    fn crlf_and_duplicate_keys_still_read() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        set_enabled(&env, &repo, true, false).unwrap();
        let key = serde_json::to_string(&project_key(&repo).unwrap()).unwrap();
        let raw = format!("{{\"enabled\":[{key},{key}]}}\r\n");
        std::fs::write(settings_file(&env), raw).unwrap();
        assert!(enabled_for(&env, &repo));
        assert!(settings_for(&env, &repo).unwrap().readable);
    }

    #[test]
    fn a_busy_lock_is_not_a_final_failure() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let lock = env.data_dir.join(LOCK_NAME);
        File::create(&lock).unwrap();
        assert_eq!(set_enabled(&env, &repo, true, false).unwrap_err(), BUSY);
        assert!(!settings_file(&env).exists());
        std::fs::remove_file(&lock).unwrap();
        set_enabled(&env, &repo, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
    }

    #[test]
    fn a_stale_lock_is_replaced() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let lock = env.data_dir.join(LOCK_NAME);
        File::create(&lock).unwrap();
        File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(10))
            .unwrap();
        set_enabled(&env, &repo, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
        assert!(!lock.exists());
    }

    #[test]
    fn two_windows_cannot_both_win() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let barrier = Arc::new(Barrier::new(2));
        let left = {
            let barrier = Arc::clone(&barrier);
            let env_dir = env.data_dir.clone();
            let repo = repo.clone();
            std::thread::spawn(move || {
                barrier.wait();
                set_enabled(&SparseEnv { data_dir: env_dir }, &repo, true, false)
            })
        };
        let right = {
            let env_dir = env.data_dir.clone();
            let repo = repo.clone();
            std::thread::spawn(move || {
                barrier.wait();
                set_enabled(&SparseEnv { data_dir: env_dir }, &repo, true, false)
            })
        };
        let results = [left.join().unwrap(), right.join().unwrap()];
        let ok = results.iter().filter(|result| result.is_ok()).count();
        let conflict = results
            .iter()
            .filter(|result| result.as_ref().err().map(String::as_str) == Some(CONFLICT))
            .count();
        assert_eq!(ok, 1, "{results:?}");
        assert_eq!(conflict, 1, "{results:?}");
        assert!(enabled_for(&env, &repo));
    }

    #[test]
    fn a_linked_state_folder_is_refused_and_its_target_is_left_alone() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let outside = scratch.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let marker = outside.join("keep.txt");
        std::fs::write(&marker, b"keep").unwrap();
        link_dir(&outside, &env.data_dir.join(DIR_NAME));
        assert!(!enabled_for(&env, &repo));
        assert_eq!(
            set_enabled(&env, &repo, true, false).unwrap_err(),
            LINK_REFUSED
        );
        assert_eq!(std::fs::read(&marker).unwrap(), b"keep");
        assert!(!outside.join(FILE_NAME).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_settings_file_is_not_followed() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let outside = scratch.root.join("secret.json");
        let key = project_key(&repo).unwrap();
        let body = format!("{{\"enabled\":[\"{key}\"]}}\n");
        std::fs::write(&outside, &body).unwrap();
        let dir = env.data_dir.join(DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(FILE_NAME)).unwrap();
        assert!(!enabled_for(&env, &repo));
        assert_eq!(settings_for(&env, &repo).unwrap_err(), LINK_REFUSED);
        assert_eq!(
            set_enabled(&env, &repo, false, false).unwrap_err(),
            LINK_REFUSED
        );
        assert_eq!(std::fs::read(&outside).unwrap(), body.as_bytes());
    }
}
