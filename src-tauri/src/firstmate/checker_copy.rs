//! SC-5: a read-only copy of a worker's checkout, for the running checker to re-run the proof in (docs/specs/
//! shipping-confidence-gap-spec.md section 4d.1).
//!
//! The checker re-runs the brief's check commands on what the worker finished, and a command a worker's brief names must
//! never be able to change that work. So the checker never runs in the worker's own folder: it gets a copy at the same
//! commit with the same uncommitted files, in a fresh folder under the temp area, that nothing may write to.
//!
//! - **The copy.** An APFS clone (`cp -c -R`: instant, shares its data with the original, and carries the installed
//!   dependencies and build output a check needs) where the volume allows it; otherwise `git worktree add --detach` at the
//!   worker's commit with the worker's uncommitted and new files laid over it (`worktrees::copy_checkout_state`).
//! - **Read-only.** File permissions are taken off the copy, and on macOS the commands run under a sandbox profile that
//!   denies every write outside the copy's own scratch folder (`agent_sandbox::read_only_wrap`). Permissions alone are not
//!   enough: a command can change them back.
//! - **Gone afterwards.** `remove` (and `Drop`) deletes the folder, and only after proving it is a direct child of the temp
//!   area with this module's name; a link is removed as a link, never followed.
//!
//! A command that needs to write inside the tree (a build into `target/`) fails in the copy and is reported as not run,
//! never as a pass.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The folder name every copy's root starts with.
pub const PREFIX: &str = "monocode-checker-";

/// How the copy was made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyHow {
    /// An APFS clone of the whole checkout.
    Clone,
    /// A detached worktree at the worker's commit, with its uncommitted files laid over it.
    Worktree,
}

impl CopyHow {
    pub fn word(self) -> &'static str {
        match self {
            CopyHow::Clone => "a clone of the worker's checkout",
            CopyHow::Worktree => {
                "a detached worktree at the worker's commit with its uncommitted files"
            }
        }
    }
}

/// What keeps a command from writing into the copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Guard {
    /// A sandbox profile denies every write outside the scratch folder, and the permissions are off the files.
    Sandbox,
    /// Only the permissions are off the files (no sandbox on this system).
    Permissions,
}

impl Guard {
    pub fn word(self) -> &'static str {
        match self {
            Guard::Sandbox => "the macOS sandbox and file permissions",
            Guard::Permissions => "file permissions only (this system has no sandbox)",
        }
    }
}

/// A read-only copy of a worker's checkout and its scratch folder. Removed when it is dropped.
#[derive(Debug)]
pub struct ReadOnlyCopy {
    /// The temp area the root lives in (canonical).
    area: PathBuf,
    /// `area/monocode-checker-<id>`: what `remove` deletes.
    root: PathBuf,
    /// The worker's checkout, for a detached worktree's removal.
    source: PathBuf,
    /// `root/copy`: where commands run.
    copy: PathBuf,
    /// `root/scratch`: the one folder they may write in.
    scratch: PathBuf,
    how: CopyHow,
    /// The sandbox prefix commands start under, when there is one (`agent_sandbox::read_only_wrap`).
    pub wrap: Option<Vec<OsString>>,
    pub guard: Guard,
    /// The project's main checkout, which the runner keys a run by. The caller sets it once it has proved the worker's
    /// checkout is the project's.
    pub project: Option<PathBuf>,
    gone: bool,
}

/// How a copy is asked to be made. `Prefer` is what the app uses; the others are for tests and for a volume that can't clone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    /// A clone when the volume can, else a worktree.
    Prefer,
    /// Only a worktree: for a volume that can't clone, and for the tests that need the worktree path on a Mac.
    #[cfg_attr(not(test), allow(dead_code))]
    Worktree,
}

impl ReadOnlyCopy {
    /// A copy that exists only in a test's mind: nothing on disk, and nothing for `remove` to do. For the checker's flow tests,
    /// whose runners are fakes.
    #[cfg(test)]
    pub(crate) fn stand_in(how: CopyHow) -> ReadOnlyCopy {
        let root = std::env::temp_dir().join(format!("{PREFIX}stand-in"));
        ReadOnlyCopy {
            area: std::env::temp_dir(),
            copy: root.join("copy"),
            scratch: root.join("scratch"),
            root,
            source: PathBuf::new(),
            how,
            wrap: None,
            guard: Guard::Sandbox,
            project: None,
            gone: true,
        }
    }

    /// Where commands run.
    pub fn copy(&self) -> &Path {
        &self.copy
    }

    /// The one folder commands may write in (`TMPDIR` points here).
    pub fn scratch(&self) -> &Path {
        &self.scratch
    }

    pub fn how(&self) -> CopyHow {
        self.how
    }

    /// Makes the copy of `source` (the worker's checkout) in a fresh folder under `area`. On any failure nothing is left.
    pub fn create(source: &Path, area: &Path, via: Via) -> Result<ReadOnlyCopy, String> {
        let source = crate::fs::canonical(source)
            .map_err(|e| format!("the worker's copy can't be read: {e}"))?;
        std::fs::create_dir_all(area).map_err(|e| format!("the temp folder can't be made: {e}"))?;
        let area = crate::fs::canonical(area)
            .map_err(|e| format!("the temp folder can't be read: {e}"))?;
        let root = area.join(format!("{PREFIX}{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).map_err(|e| format!("the temp folder can't be made: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
        }
        // Built before anything is copied, so a failure below removes what was made.
        let mut made = ReadOnlyCopy {
            copy: root.join("copy"),
            scratch: root.join("scratch"),
            area,
            root,
            source,
            how: CopyHow::Worktree,
            wrap: None,
            guard: Guard::Permissions,
            project: None,
            gone: false,
        };
        std::fs::create_dir(&made.scratch)
            .map_err(|e| format!("the checker's scratch folder can't be made: {e}"))?;
        let cloned = via == Via::Prefer && clone_tree(&made.source, &made.copy).is_ok();
        if cloned {
            made.how = CopyHow::Clone;
        } else {
            // A clone that failed part way leaves a half copy: `git worktree add` needs the place empty.
            if made.copy.exists() {
                make_writable(&made.copy);
                let _ = std::fs::remove_dir_all(&made.copy);
            }
            worktree_copy(&made.source, &made.copy)?;
            made.how = CopyHow::Worktree;
        }
        make_read_only(&made.copy);
        Ok(made)
    }

    /// Deletes the copy, the scratch folder and the root. Only a direct child of the temp area named `monocode-checker-…`
    /// is ever removed; anything else is refused and left. Safe to call twice.
    pub fn remove(&mut self) -> Result<(), String> {
        if self.gone {
            return Ok(());
        }
        prove_inside(&self.area, &self.root)?;
        if self.how == CopyHow::Worktree && self.copy.exists() {
            // The worker's repository keeps a note of a worktree: take it out first, or it is left behind.
            make_writable(&self.copy);
            let copy = self.copy.to_string_lossy().into_owned();
            let _ = super::gates::git(&self.source, &["worktree", "remove", "--force", &copy]);
            let _ = super::gates::git(&self.source, &["worktree", "prune"]);
        }
        make_writable(&self.root);
        match std::fs::remove_dir_all(&self.root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("the checker's copy couldn't be removed: {error}")),
        }
        self.gone = true;
        Ok(())
    }
}

impl Drop for ReadOnlyCopy {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}

/// `root` is a direct child of `area` and named for this module, once both are resolved. A link, a `..`, the area itself
/// or any other place is not.
fn prove_inside(area: &Path, root: &Path) -> Result<(), String> {
    let refuse = || {
        format!(
            "refused to remove {}: it is not a checker folder inside the temp area",
            root.display()
        )
    };
    let area = crate::fs::canonical(area).map_err(|_| refuse())?;
    let real = match crate::fs::canonical(root) {
        Ok(real) => real,
        // Already gone: nothing to remove, and nothing to refuse.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(refuse()),
    };
    let named = real
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(PREFIX) && name.len() > PREFIX.len());
    if real.parent() == Some(area.as_path()) && named {
        Ok(())
    } else {
        Err(refuse())
    }
}

/// The whole checkout, cloned: APFS shares the data and copies nothing, and a symbolic link is copied as a link.
#[cfg(target_os = "macos")]
fn clone_tree(source: &Path, dest: &Path) -> Result<(), String> {
    let out = std::process::Command::new("/bin/cp")
        .args(["-c", "-R"])
        .arg(source)
        .arg(dest)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() && dest.is_dir() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn clone_tree(_source: &Path, _dest: &Path) -> Result<(), String> {
    Err("this system has no clone copy".into())
}

/// A detached worktree at the worker's HEAD, then its uncommitted and new files on top.
fn worktree_copy(source: &Path, dest: &Path) -> Result<(), String> {
    let place = dest.to_string_lossy().into_owned();
    let (ok, _, _) = super::gates::git(
        source,
        &["worktree", "add", "--detach", "--quiet", &place, "HEAD"],
    )?;
    if !ok {
        return Err("git couldn't make a copy of the worker's checkout".into());
    }
    crate::worktrees::copy_checkout_state(source, dest)
        .map_err(|e| format!("the worker's uncommitted files couldn't be copied: {e}"))
}

/// Takes the write permission off every file and folder under `path`, and not off anything a link points to.
pub fn make_read_only(path: &Path) {
    set_writable(path, false);
}

/// The reverse, so the copy can be deleted: a folder with no write permission can't have its entries removed.
pub fn make_writable(path: &Path) {
    set_writable(path, true);
}

fn set_writable(path: &Path, writable: bool) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    // A link is never followed: what it points to is not this copy's to change.
    if meta.file_type().is_symlink() {
        return;
    }
    if meta.is_dir() {
        // A folder is made writable before its entries are touched, and made read-only after.
        if writable {
            set_mode(path, &meta, true);
        }
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                set_writable(&entry.path(), writable);
            }
        }
        if !writable {
            set_mode(path, &meta, false);
        }
    } else {
        set_mode(path, &meta, writable);
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, meta: &std::fs::Metadata, writable: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = meta.permissions().mode();
    let next = if writable {
        mode | 0o200
    } else {
        mode & !0o222
    };
    if next != mode {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(next));
    }
}

#[cfg(not(unix))]
fn set_mode(path: &Path, meta: &std::fs::Metadata, writable: bool) {
    // Windows has one flag, and only on files.
    if meta.is_dir() {
        return;
    }
    let mut permissions = meta.permissions();
    if permissions.readonly() == !writable {
        return;
    }
    permissions.set_readonly(!writable);
    let _ = std::fs::set_permissions(path, permissions);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let out = crate::git_cmd::git()
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A workspace with a project (a spaced, non-ASCII folder name), one commit, and a temp area beside it.
    struct World {
        root: PathBuf,
        project: PathBuf,
        area: PathBuf,
    }

    impl Drop for World {
        fn drop(&mut self) {
            make_writable(&self.root);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn world(name: &str) -> World {
        let root = std::env::temp_dir().join(format!(
            "hivra-checker-copy-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = root.join("my pr\u{f6}ject");
        std::fs::create_dir_all(project.join("src")).unwrap();
        sh(&project, &["init", "-q", "-b", "main"]);
        std::fs::write(project.join("src/app.ts"), "export const a = 1;\n").unwrap();
        std::fs::write(project.join("gone.ts"), "export const g = 1;\n").unwrap();
        std::fs::write(project.join(".gitignore"), "ignored.log\n").unwrap();
        sh(&project, &["add", "-A"]);
        sh(&project, &["commit", "-q", "-m", "start"]);
        let area = root.join("tmp area");
        World {
            root,
            project,
            area,
        }
    }

    /// The worker's unfinished work: an edited file, a deleted one, a new one, and one git ignores.
    fn finish_work(project: &Path) {
        std::fs::write(project.join("src/app.ts"), "export const a = 2;\n").unwrap();
        std::fs::remove_file(project.join("gone.ts")).unwrap();
        std::fs::write(project.join("src/new.ts"), "export const n = 1;\n").unwrap();
        std::fs::write(project.join("ignored.log"), "noise\n").unwrap();
    }

    fn text(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn the_worktree_copy_has_the_commit_and_the_uncommitted_and_new_files_in_the_temp_area() {
        let world = world("worktree");
        finish_work(&world.project);
        let copy = ReadOnlyCopy::create(&world.project, &world.area, Via::Worktree).unwrap();
        assert_eq!(copy.how(), CopyHow::Worktree);
        // It lives in the temp area, in a folder of its own, and not in the worker's folder.
        let area = crate::fs::canonical(&world.area).unwrap();
        assert!(copy.copy().starts_with(&area), "{:?}", copy.copy());
        assert!(copy.scratch().starts_with(&area));
        assert!(!copy.copy().starts_with(&world.project));
        assert_eq!(
            text(&copy.copy().join("src/app.ts")),
            "export const a = 2;\n"
        );
        assert_eq!(
            text(&copy.copy().join("src/new.ts")),
            "export const n = 1;\n"
        );
        assert!(!copy.copy().join("gone.ts").exists());
        // Files git ignores are not carried by a worktree copy.
        assert!(!copy.copy().join("ignored.log").exists());
        // The worker's own folder is as it was left.
        assert_eq!(
            text(&world.project.join("src/app.ts")),
            "export const a = 2;\n"
        );
    }

    #[test]
    fn the_preferred_copy_has_the_same_files_whichever_way_it_was_made() {
        let world = world("prefer");
        finish_work(&world.project);
        let copy = ReadOnlyCopy::create(&world.project, &world.area, Via::Prefer).unwrap();
        assert_eq!(
            text(&copy.copy().join("src/app.ts")),
            "export const a = 2;\n"
        );
        assert_eq!(
            text(&copy.copy().join("src/new.ts")),
            "export const n = 1;\n"
        );
        assert!(!copy.copy().join("gone.ts").exists());
        if copy.how() == CopyHow::Clone {
            // A clone carries ignored files too: that is how a check finds the installed dependencies.
            assert!(copy.copy().join("ignored.log").exists());
        }
    }

    #[test]
    fn the_copy_is_removed_and_only_what_it_made() {
        let world = world("remove");
        finish_work(&world.project);
        let mut copy = ReadOnlyCopy::create(&world.project, &world.area, Via::Worktree).unwrap();
        let root = copy.root.clone();
        let other = world.area.join("someone-elses-folder");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("keep.txt"), "keep").unwrap();
        assert!(root.is_dir());
        copy.remove().unwrap();
        assert!(!root.exists(), "the root is gone");
        // Calling it again is fine, and what else was in the temp area is untouched.
        copy.remove().unwrap();
        assert_eq!(text(&other.join("keep.txt")), "keep");
        // The worker's repository keeps no note of the worktree.
        let out = crate::git_cmd::git()
            .arg("-C")
            .arg(&world.project)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        let listed = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(!listed.contains(PREFIX), "{listed}");
        // The worker's files are untouched.
        assert_eq!(
            text(&world.project.join("src/app.ts")),
            "export const a = 2;\n"
        );
    }

    #[test]
    fn dropping_the_copy_removes_it() {
        let world = world("drop");
        let root = {
            let copy = ReadOnlyCopy::create(&world.project, &world.area, Via::Worktree).unwrap();
            let root = copy.root.clone();
            assert!(root.is_dir());
            root
        };
        assert!(!root.exists());
    }

    #[test]
    fn a_folder_that_is_not_a_checker_folder_inside_the_temp_area_is_never_removed() {
        let world = world("prove");
        let mut copy = ReadOnlyCopy::create(&world.project, &world.area, Via::Worktree).unwrap();
        let real_root = copy.root.clone();
        let area = copy.area.clone();
        let victim = world.root.join("victim");
        std::fs::create_dir_all(&victim).unwrap();
        for forged in [
            // Outside the temp area, even though it is named right.
            world.root.join(format!("{PREFIX}elsewhere")),
            // The temp area itself and its parent.
            area.clone(),
            world.root.clone(),
            // Inside the area but not named for this module.
            area.join("victim"),
            // A `..` that leaves the area.
            area.join(PREFIX.to_string() + "x")
                .join("..")
                .join("..")
                .join("victim"),
            // Two levels down.
            real_root.join("scratch"),
            // Only the prefix, no id.
            area.join(PREFIX),
        ] {
            std::fs::create_dir_all(&forged).unwrap();
            std::fs::write(forged.join("precious.txt"), "precious").unwrap();
            let mut forgery = ReadOnlyCopy {
                area: area.clone(),
                root: forged.clone(),
                source: world.project.clone(),
                copy: forged.join("copy"),
                scratch: forged.join("scratch"),
                how: CopyHow::Clone,
                wrap: None,
                guard: Guard::Permissions,
                project: None,
                gone: false,
            };
            let outcome = forgery.remove();
            // Whatever it was, it is still there, and the answer says it refused.
            assert!(outcome.is_err(), "{forged:?} was not refused");
            assert_eq!(
                text(&forged.join("precious.txt")),
                "precious",
                "{forged:?} was removed"
            );
            // Never let the forgery's Drop try again.
            forgery.gone = true;
        }
        assert_eq!(text(&victim.join("precious.txt")), "precious");
        copy.remove().unwrap();
    }

    #[test]
    fn a_failed_copy_leaves_nothing_in_the_temp_area() {
        let world = world("fail");
        let not_git = world.root.join("plain folder");
        std::fs::create_dir_all(&not_git).unwrap();
        std::fs::write(not_git.join("a.txt"), "a").unwrap();
        let err = ReadOnlyCopy::create(&not_git, &world.area, Via::Worktree).unwrap_err();
        assert!(!err.is_empty());
        let left: Vec<_> = std::fs::read_dir(&world.area)
            .map(|dir| dir.flatten().map(|e| e.file_name()).collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "left behind: {left:?}");
        // A source that is not there is refused the same way.
        assert!(
            ReadOnlyCopy::create(&world.root.join("missing"), &world.area, Via::Prefer).is_err()
        );
    }

    #[test]
    fn two_copies_at_once_do_not_collide() {
        let world = world("two");
        let one = ReadOnlyCopy::create(&world.project, &world.area, Via::Worktree).unwrap();
        let two = ReadOnlyCopy::create(&world.project, &world.area, Via::Worktree).unwrap();
        assert_ne!(one.copy(), two.copy());
        assert!(one.copy().join("src/app.ts").exists());
        assert!(two.copy().join("src/app.ts").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_copy_cannot_be_written_to_and_the_scratch_folder_can() {
        // The superuser writes through any permission; there is nothing to prove as one.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let world = world("readonly");
        let copy = ReadOnlyCopy::create(&world.project, &world.area, Via::Worktree).unwrap();
        // No new file in the tree, no change to a file, no new folder.
        assert!(std::fs::write(copy.copy().join("new.txt"), "x").is_err());
        assert!(std::fs::write(copy.copy().join("src/app.ts"), "x").is_err());
        assert!(std::fs::create_dir(copy.copy().join("src/sub")).is_err());
        assert_eq!(
            text(&copy.copy().join("src/app.ts")),
            "export const a = 1;\n"
        );
        // The scratch folder is the one place to write.
        std::fs::write(copy.scratch().join("out.txt"), "ok").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_tree_is_never_followed_by_the_permissions_or_the_removal() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let world = world("link");
        // The worker's folder links to something outside it, as a project links `node_modules` from its main checkout.
        let outside = world.root.join("shared modules");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("dep.js"), "dep").unwrap();
        symlink(&outside, world.project.join("node_modules")).unwrap();
        sh(&world.project, &["add", "-A"]);
        sh(&world.project, &["commit", "-q", "-m", "link"]);
        let mut copy = ReadOnlyCopy::create(&world.project, &world.area, Via::Prefer).unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o222;
        assert_ne!(
            mode(&outside.join("dep.js")),
            0,
            "the link's target was made read-only"
        );
        assert_ne!(
            mode(&outside),
            0,
            "the link's target folder was made read-only"
        );
        copy.remove().unwrap();
        assert_eq!(
            text(&outside.join("dep.js")),
            "dep",
            "the removal followed the link"
        );
    }

    #[test]
    fn permissions_come_off_and_go_back_without_touching_a_link_and_a_missing_path_is_fine() {
        let dir = std::env::temp_dir().join(format!("hivra-perm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("a/b/f.txt"), "f").unwrap();
        make_read_only(&dir);
        assert!(std::fs::metadata(dir.join("a/b/f.txt"))
            .unwrap()
            .permissions()
            .readonly());
        make_writable(&dir);
        assert!(!std::fs::metadata(dir.join("a/b/f.txt"))
            .unwrap()
            .permissions()
            .readonly());
        std::fs::write(dir.join("a/b/f.txt"), "g").unwrap();
        make_read_only(&dir.join("does-not-exist"));
        make_writable(&dir.join("does-not-exist"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
