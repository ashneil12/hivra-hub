//! Dev-only fault injection for scripted tests (scorecard D5: "a worker fails 3 times, its Lead gives up, Ash sees one
//! Needs you row"). Off by default. Nothing in the app turns it on: it is armed only by a file a tester writes by hand,
//! `<app data>/dev-faults/fail-next-workers`, whose first line must be exactly `fail-next-workers` and whose second line
//! is how many of the next delegated workers fail (1-5). An armed file older than ARM_TTL_SECS is ignored and removed,
//! so a forgotten one can never break real work later. Each worker that takes a fault counts it down; at zero the file
//! is removed. Docs: docs/DEV-FAULTS.md.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

pub(crate) const MAGIC: &str = "fail-next-workers";
pub(crate) const ARM_TTL_SECS: u64 = 2 * 60 * 60;
pub(crate) const MAX_COUNT: u32 = 5;
pub(crate) const FAULT_ERROR: &str =
    "Test fault: this worker was set to fail on purpose for a test (dev-faults/fail-next-workers).";

fn fault_file(app: &AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .app_data_dir()
            .ok()?
            .join("dev-faults")
            .join(MAGIC),
    )
}

/// Take one armed worker fault from `path`, if there is one: Some(error text) and the count goes down by one.
pub(crate) fn take_at(path: &Path, now: SystemTime) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let age = now
        .duration_since(meta.modified().ok()?)
        .unwrap_or(Duration::ZERO);
    if age > Duration::from_secs(ARM_TTL_SECS) {
        let _ = std::fs::remove_file(path);
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines().map(str::trim);
    if lines.next() != Some(MAGIC) {
        return None;
    }
    let count: u32 = lines.next()?.parse().ok()?;
    if count == 0 || count > MAX_COUNT {
        let _ = std::fs::remove_file(path);
        return None;
    }
    let left = count - 1;
    if left == 0 {
        std::fs::remove_file(path).ok()?;
    } else {
        // keep the file's age (the arm time) so the TTL still counts from when the tester armed it
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, format!("{MAGIC}\n{left}\n")).ok()?;
        let _ = std::fs::File::options()
            .write(true)
            .open(&tmp)
            .and_then(|f| f.set_modified(meta.modified()?));
        std::fs::rename(&tmp, path).ok()?;
    }
    eprintln!("[dev-fault] a delegated worker takes a test failure ({left} left)");
    Some(FAULT_ERROR.to_string())
}

/// The app asks this once per delegated worker it starts. None (the normal case) unless a tester armed it.
#[tauri::command]
pub fn dev_fault_take_worker_failure(app: AppHandle) -> Option<String> {
    take_at(&fault_file(&app)?, SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> Dir {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "mc-dev-fault-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        Dir(d)
    }

    fn arm(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join(MAGIC);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn nothing_is_armed_by_default() {
        let dir = tempdir();
        assert_eq!(take_at(&dir.path().join(MAGIC), SystemTime::now()), None);
    }

    #[test]
    fn an_armed_file_fails_exactly_that_many_workers_then_is_gone() {
        let dir = tempdir();
        let path = arm(dir.path(), "fail-next-workers\n3\n");
        for _ in 0..3 {
            assert_eq!(
                take_at(&path, SystemTime::now()).as_deref(),
                Some(FAULT_ERROR)
            );
        }
        assert!(!path.exists());
        assert_eq!(take_at(&path, SystemTime::now()), None);
    }

    #[test]
    fn a_file_without_the_exact_first_line_or_a_sane_count_does_nothing() {
        let dir = tempdir();
        for body in [
            "3\n",
            "fail next workers\n3\n",
            "fail-next-workers\n",
            "fail-next-workers\nlots\n",
            "fail-next-workers\n0\n",
            "fail-next-workers\n99\n",
        ] {
            let path = arm(dir.path(), body);
            assert_eq!(take_at(&path, SystemTime::now()), None, "{body:?}");
        }
    }

    #[test]
    fn a_forgotten_armed_file_expires_and_is_removed() {
        let dir = tempdir();
        let path = arm(dir.path(), "fail-next-workers\n2\n");
        let later = SystemTime::now() + Duration::from_secs(ARM_TTL_SECS + 60);
        assert_eq!(take_at(&path, later), None);
        assert!(!path.exists());
    }
}
