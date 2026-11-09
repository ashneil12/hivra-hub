//! WP-143: write Claude Code's Explore and Plan agent files into a session folder.
//!
//! The file is created only when it is missing. An existing file is left as it
//! is. The user's own `.claude` directory is never a destination, including
//! when a link would land there.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path};

const EXPLORE: &str = ".claude/agents/Explore.md";
const PLAN: &str = ".claude/agents/Plan.md";
const MAX_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorePinFile {
    pub relative: String,
    pub content: String,
}

/// Create the missing pin files in `cwd`. Returns the relative paths written.
/// A refusal or a problem writes nothing new and is not a failed launch.
#[tauri::command]
pub fn ensure_cheap_explore_pin(
    cwd: String,
    files: Vec<ExplorePinFile>,
) -> Result<Vec<String>, String> {
    Ok(write_explore_pin(
        Path::new(&cwd),
        &files,
        dirs::home_dir().as_deref(),
    ))
}

pub(crate) fn write_explore_pin(
    cwd: &Path,
    files: &[ExplorePinFile],
    home: Option<&Path>,
) -> Vec<String> {
    if !cwd_ok(cwd) {
        return Vec::new();
    }
    let wanted: Vec<&ExplorePinFile> = files.iter().filter(|file| file_ok(file)).collect();
    if wanted.is_empty() {
        return Vec::new();
    }
    let Ok(root) = crate::fs::canonical(cwd) else {
        return Vec::new();
    };
    if !root.is_dir() || blocked(&root, home) {
        return Vec::new();
    }
    let claude_dir = root.join(".claude");
    let agents = claude_dir.join("agents");
    if ensure_real_dir(&claude_dir, &root, home).is_err() {
        return Vec::new();
    }
    if ensure_real_dir(&agents, &root, home).is_err() {
        return Vec::new();
    }
    let mut created = Vec::new();
    for file in wanted {
        let Some(name) = file_name(&file.relative) else {
            continue;
        };
        let path = agents.join(name);
        if create_new(&path, &file.content, &root, home) == Some(true) {
            created.push(file.relative.clone());
        }
    }
    created
}

fn cwd_ok(cwd: &Path) -> bool {
    cwd.is_absolute()
        && !cwd
            .components()
            .any(|component| component == Component::ParentDir)
        && !has_claude_component(cwd)
}

fn has_claude_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(part) => part.eq_ignore_ascii_case(".claude"),
        _ => false,
    })
}

fn file_name(relative: &str) -> Option<&'static str> {
    if relative == EXPLORE {
        Some("Explore.md")
    } else if relative == PLAN {
        Some("Plan.md")
    } else {
        None
    }
}

fn file_ok(file: &ExplorePinFile) -> bool {
    file_name(&file.relative).is_some() && content_ok(&file.relative, &file.content)
}

fn content_ok(relative: &str, content: &str) -> bool {
    if content.len() > MAX_BYTES || content.contains('\0') || content.contains('\r') {
        return false;
    }
    let expected = if relative == EXPLORE {
        "Explore"
    } else if relative == PLAN {
        "Plan"
    } else {
        return false;
    };
    let mut named = false;
    let mut models = 0;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("name:") {
            if rest.trim() != expected {
                return false;
            }
            named = true;
        }
        if let Some(rest) = line.strip_prefix("model:") {
            let value = rest.trim();
            if value.is_empty() || !model_ok(value) {
                return false;
            }
            models += 1;
        }
    }
    named && models == 1
}

fn model_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// True when `path` is the user's `.claude` directory, is inside it, or would
/// create that directory by writing `.claude` under the home folder.
fn blocked(root: &Path, home: Option<&Path>) -> bool {
    let Some(home) = home else {
        return false;
    };
    let home = crate::fs::canonical(home).unwrap_or_else(|_| home.to_path_buf());
    let marker = home.join(".claude");
    let marker_real = crate::fs::canonical(&marker).unwrap_or(marker);
    root == marker_real || root.starts_with(&marker_real) || root.join(".claude") == marker_real
}

fn ensure_real_dir(dir: &Path, root: &Path, home: Option<&Path>) -> Result<(), ()> {
    let mut made = false;
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(()),
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(dir).map_err(|_| ())?;
            made = true;
            let meta = fs::symlink_metadata(dir).map_err(|_| ())?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                let _ = fs::remove_dir(dir);
                return Err(());
            }
        }
        Err(_) => return Err(()),
    }
    let canon = crate::fs::canonical(dir).map_err(|_| ())?;
    let root = crate::fs::canonical(root).map_err(|_| ())?;
    if !canon.starts_with(&root) || blocked(&canon, home) {
        // Only a directory this call created is removed, and never through a link.
        if made {
            let _ = fs::remove_dir(dir);
        }
        return Err(());
    }
    Ok(())
}

/// `Some(true)` when this call created the file. `Some(false)` when a file was
/// already there. `None` when the write was refused.
fn create_new(path: &Path, content: &str, root: &Path, home: Option<&Path>) -> Option<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => return Some(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .ok()?;
    if file.write_all(content.as_bytes()).is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return None;
    }
    let _ = file.sync_all();
    drop(file);
    let canon = match crate::fs::canonical(path) {
        Ok(path) => path,
        Err(_) => {
            let _ = fs::remove_file(path);
            return None;
        }
    };
    if !canon.starts_with(root) || blocked(&canon, home) || blocked(root, home) {
        let _ = fs::remove_file(path);
        return None;
    }
    Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "explore-pin-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn path(&self) -> &Path {
            &self.dir
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn pin(model: &str, name: &str) -> ExplorePinFile {
        let relative = if name == "Plan" { PLAN } else { EXPLORE };
        let title = if name == "Plan" { "Plan" } else { "Explore" };
        ExplorePinFile {
            relative: relative.to_string(),
            content: format!("---\nname: {title}\nmodel: {model}\n---\n\nRead only.\n"),
        }
    }

    fn both(model: &str) -> Vec<ExplorePinFile> {
        vec![pin(model, "Explore"), pin(model, "Plan")]
    }

    #[test]
    fn a_fresh_folder_gets_an_explicit_model_and_a_second_call_changes_nothing() {
        let scratch = Scratch::new();
        let project = scratch.path().join("my project");
        fs::create_dir(&project).unwrap();
        let home = scratch.path().join("home");
        fs::create_dir(&home).unwrap();
        let created = write_explore_pin(&project, &both("haiku"), Some(&home));
        assert_eq!(created, vec![EXPLORE.to_string(), PLAN.to_string()]);
        let explore = fs::read_to_string(project.join(EXPLORE)).unwrap();
        assert!(explore.contains("model: haiku"));
        assert!(!explore.contains('\r'));
        assert!(write_explore_pin(&project, &both("opus"), Some(&home)).is_empty());
        assert_eq!(fs::read_to_string(project.join(EXPLORE)).unwrap(), explore);
    }

    #[test]
    fn an_existing_file_is_left_alone_with_or_without_a_model() {
        let scratch = Scratch::new();
        let cases = [
            (
                "---\nname: Explore\nmodel: opus\n---\n\nKeep me.\n",
                "---\nname: Plan\nmodel: opus\n---\n\nKeep me.\n",
            ),
            ("", "---\nname: Plan\n---\n\nNo model.\n"),
        ];
        for (index, (explore, plan)) in cases.into_iter().enumerate() {
            let project = scratch.path().join(format!("proj-{index}"));
            let agents = project.join(".claude").join("agents");
            fs::create_dir_all(&agents).unwrap();
            fs::write(agents.join("Explore.md"), explore).unwrap();
            fs::write(agents.join("Plan.md"), plan).unwrap();
            assert!(write_explore_pin(&project, &both("haiku"), Some(scratch.path())).is_empty());
            assert_eq!(
                fs::read_to_string(agents.join("Explore.md")).unwrap(),
                explore
            );
            assert_eq!(fs::read_to_string(agents.join("Plan.md")).unwrap(), plan);
        }
    }

    #[test]
    fn the_user_claude_directory_and_the_home_folder_are_never_written() {
        let scratch = Scratch::new();
        let home = scratch.path().join("home");
        let claude = home.join(".claude");
        let app = claude.join("projects").join("app");
        fs::create_dir_all(&app).unwrap();
        let before = fs::read_dir(&claude).unwrap().count();
        assert!(write_explore_pin(&claude, &both("haiku"), Some(&home)).is_empty());
        assert!(write_explore_pin(&app, &both("haiku"), Some(&home)).is_empty());
        assert!(write_explore_pin(&home, &both("haiku"), Some(&home)).is_empty());
        assert!(!home
            .join(".claude")
            .join("agents")
            .join("Explore.md")
            .exists());
        assert_eq!(fs::read_dir(&claude).unwrap().count(), before);
    }

    #[test]
    fn a_relative_path_a_parent_segment_and_a_bad_file_write_nothing() {
        let scratch = Scratch::new();
        let project = scratch.path().join("proj");
        fs::create_dir(&project).unwrap();
        let home = scratch.path().join("home");
        fs::create_dir(&home).unwrap();
        assert!(write_explore_pin(Path::new("proj"), &both("haiku"), Some(&home)).is_empty());
        let escaped = project.join("..").join("elsewhere");
        assert!(write_explore_pin(&escaped, &both("haiku"), Some(&home)).is_empty());
        let bad = vec![
            ExplorePinFile {
                relative: "../Explore.md".into(),
                content: pin("haiku", "Explore").content,
            },
            ExplorePinFile {
                relative: EXPLORE.into(),
                content: "---\nname: Explore\n---\n\nNo model.\n".into(),
            },
            ExplorePinFile {
                relative: EXPLORE.into(),
                content: "---\nname: Explore\nmodel: haiku\r\n---\n".into(),
            },
        ];
        assert!(write_explore_pin(&project, &bad, Some(&home)).is_empty());
        assert!(!project.join(".claude").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_that_points_at_the_user_claude_directory_is_not_followed() {
        let scratch = Scratch::new();
        let home = scratch.path().join("home");
        let claude = home.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        let project = scratch.path().join("proj");
        fs::create_dir(&project).unwrap();
        std::os::unix::fs::symlink(&claude, project.join(".claude")).unwrap();
        assert!(write_explore_pin(&project, &both("haiku"), Some(&home)).is_empty());
        assert!(!claude.join("agents").join("Explore.md").exists());
        assert!(fs::symlink_metadata(project.join(".claude"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_folder_that_is_really_the_user_claude_directory_is_refused() {
        let scratch = Scratch::new();
        let home = scratch.path().join("home");
        let claude = home.join(".claude");
        let inside = claude.join("work");
        fs::create_dir_all(&inside).unwrap();
        let alias = scratch.path().join("alias");
        std::os::unix::fs::symlink(&inside, &alias).unwrap();
        assert!(write_explore_pin(&alias, &both("haiku"), Some(&home)).is_empty());
        assert!(!inside.join(".claude").exists());
        assert!(!claude.join("agents").exists());
    }

    /// Windows has no symlink here. The same refusal is the canonical path check,
    /// which the home-folder test above already runs on every platform.
    #[cfg(windows)]
    #[test]
    fn a_linked_claude_directory_is_covered_on_unix() {}
}
