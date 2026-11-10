// WP-91: a handoff for every node. A worker writes one short file inside its own checkout, at
// `.hivra/handoff/<taskId>.md`, with four headings; `review` refuses acceptance while it is missing, and the run
// records its canonical path and digest.
//
// The app cannot prove the author was honest. It can prove the file exists, that it is inside the worker's checkout,
// and that the lead opened it before accepting — which is what this module does.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::Refusal;

/// Where a worker writes its handoff, relative to its checkout.
pub const DIR: &str = ".hivra/handoff";
/// The most of a handoff that is read, so a runaway file cannot fill the run record.
pub const READ_MAX: usize = 64 * 1024;
/// The four headings the report shape asks for, in the order the prompt names them.
pub const HEADINGS: [&str; 4] = ["Changed", "Files", "Checked", "Left"];

/// A handoff file, proved to be inside the checkout it was written in.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffFile {
    /// The canonical path, in the form people and git can use.
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    /// What it says, capped at [`READ_MAX`].
    pub text: String,
    /// The headings it actually holds, in the order [`HEADINGS`] names them.
    pub headings: Vec<String>,
    /// The headings it is missing. A note, never a refusal: the app proves the file exists, not that it is good.
    pub missing: Vec<String>,
}

/// The task id as one safe path segment. A `..`, a separator, a drive letter, a Windows path or anything that is not
/// a plain id is refused, so the file it names is always the one inside the checkout.
pub fn safe_segment(task_id: &str) -> Result<&str, Refusal> {
    let refused = || {
        Refusal::new(
            "invalid_task_id",
            format!("A handoff file is named after its task id, and {task_id:?} is not one."),
        )
    };
    if task_id.is_empty() || task_id.len() > 128 {
        return Err(refused());
    }
    if task_id == "."
        || task_id == ".."
        || task_id.contains('/')
        || task_id.contains('\\')
        || task_id.contains(':')
        || task_id.contains('\0')
        || task_id.chars().any(char::is_control)
    {
        return Err(refused());
    }
    Ok(task_id)
}

/// Whether a project-relative path is in the folder a worker writes its handoff in (`.hivra/handoff`), and nothing
/// wider: another file under `.hivra` is the project's own and keeps its place in a worker's changes.
///
/// A handoff is the app's note about a worker's work, read in the worker's checkout when the lead accepts the task. It
/// is never part of what the worker changed, so integration leaves it out and does not wait for it to have been
/// captured at a tool boundary (a note written by the shell never is). Separators are normalised, `.` parts are
/// dropped and case is folded on Windows, as `containment_key` does; a path with a `..` is not trusted to be one.
pub fn is_handoff(relative: &str) -> bool {
    let slashed = relative.replace('\\', "/");
    let mut parts = Vec::new();
    for part in slashed.split('/') {
        match part {
            "" | "." => {}
            ".." => return false,
            other => parts.push(other),
        }
    }
    let dir: Vec<&str> = DIR.split('/').collect();
    parts.len() >= dir.len()
        && parts.iter().zip(&dir).all(|(left, right)| {
            if cfg!(windows) {
                left.eq_ignore_ascii_case(right)
            } else {
                left == right
            }
        })
}

/// The handoff's path inside a checkout, without touching the disk.
pub fn relative_path(task_id: &str) -> Result<PathBuf, Refusal> {
    Ok(Path::new(DIR).join(format!("{}.md", safe_segment(task_id)?)))
}

/// The form two paths are compared in: separators normalised, and case folded on Windows, exactly as `control.rs`'s
/// `comparison_path` does for write scopes. Duplicated here rather than exported, so no upstream file changes.
fn containment_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn inside(checkout: &Path, path: &Path) -> bool {
    let root = containment_key(checkout);
    let candidate = containment_key(path);
    candidate == root || candidate.starts_with(&format!("{root}/"))
}

/// Read the handoff written in `checkout` and prove it belongs there.
///
/// A missing file, a file outside the checkout (through a symlink, say), an unreadable one, or a task id that is not
/// a plain segment is refused with the reason code `handoff_missing` and one plain sentence.
pub fn read(checkout: &str, task_id: &str) -> Result<HandoffFile, Refusal> {
    let root = PathBuf::from(checkout);
    let relative = relative_path(task_id)?;
    let canonical_root = crate::fs::canonical(&root).map_err(|error| {
        Refusal::new(
            "handoff_missing",
            format!("This worker's checkout could not be read ({error}), so its handoff cannot be checked."),
        )
    })?;
    let candidate = canonical_root.join(&relative);
    let canonical = crate::fs::canonical(&candidate).map_err(|_| {
        Refusal::new(
            "handoff_missing",
            format!(
                "No handoff file at {}. Write one from the worker's result before accepting it.",
                relative.display()
            ),
        )
    })?;
    if !inside(&canonical_root, &canonical) {
        return Err(Refusal::new(
            "handoff_outside_checkout",
            format!(
                "The handoff at {relative_display} points outside the worker's checkout, so it is not accepted.",
                relative_display = relative.display()
            ),
        ));
    }
    // Read at most one byte past the cap, so a runaway or sparse handoff costs a bounded read: the old
    // `fs::read` pulled the whole file into memory before capping it. The file's length comes from its metadata.
    let file = std::fs::File::open(&canonical).map_err(|error| {
        Refusal::new(
            "handoff_missing",
            format!("The handoff could not be read ({error})."),
        )
    })?;
    let whole = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut head = Vec::with_capacity(READ_MAX + 1);
    file.take(READ_MAX as u64 + 1)
        .read_to_end(&mut head)
        .map_err(|error| {
            Refusal::new(
                "handoff_missing",
                format!("The handoff could not be read ({error})."),
            )
        })?;
    let mut text = String::from_utf8_lossy(&head[..head.len().min(READ_MAX)]).to_string();
    if whole > READ_MAX as u64 || head.len() > READ_MAX {
        text.push('…');
    }
    // The digest covers what was read (the whole file unless it is over the cap), so it can be checked without
    // reading more than the cap.
    let sha256 = format!("{:x}", Sha256::digest(&head));
    let found: Vec<String> = HEADINGS
        .iter()
        .filter(|heading| names_heading(&text, heading))
        .map(|heading| (*heading).to_string())
        .collect();
    let missing: Vec<String> = HEADINGS
        .iter()
        .filter(|heading| !found.iter().any(|seen| seen == *heading))
        .map(|heading| (*heading).to_string())
        .collect();
    Ok(HandoffFile {
        path: crate::fs::path_to_js(&canonical),
        sha256,
        bytes: whole,
        text,
        headings: found,
        missing,
    })
}

/// Whether the report holds a heading, as `## Checked` or `Checked:` — the two shapes a short report is written in.
fn names_heading(text: &str, heading: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim().trim_start_matches('#').trim();
        let line = line.split(':').next().unwrap_or(line).trim();
        line.eq_ignore_ascii_case(heading)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("goal-handoff-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(checkout: &Path, task: &str, body: &str) -> PathBuf {
        let path = checkout.join(relative_path(task).unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn a_task_id_that_is_not_one_plain_segment_is_refused() {
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:/x",
            "../x",
            "a\0b",
            "a\nb",
            &"x".repeat(129),
        ] {
            assert!(safe_segment(bad).is_err(), "{bad:?} should be refused");
        }
        assert_eq!(safe_segment("task-1").unwrap(), "task-1");
        assert_eq!(safe_segment("9f0f-1").unwrap(), "9f0f-1");
    }

    #[test]
    fn only_the_handoff_folder_is_a_handoff_path() {
        // What integration leaves out of a worker's changes: the folder this module reads from, nothing wider.
        for handoff in [
            ".hivra/handoff/task-1.md",
            ".hivra/handoff/sub/note.md",
            ".hivra/handoff",
            ".hivra\\handoff\\task-1.md",
            "./.hivra/handoff/task-1.md",
        ] {
            assert!(is_handoff(handoff), "{handoff:?} is the handoff folder");
        }
        for other in [
            "",
            ".hivra",
            ".hivra/config.json",
            ".hivra/handoffs/task-1.md",
            ".hivra/handoff-old/task-1.md",
            "src/.hivra/handoff/task-1.md",
            "handoff/task-1.md",
            "src/a.ts",
        ] {
            assert!(!is_handoff(other), "{other:?} is the project's own file");
        }
        // A `..` is never trusted to lead into the folder: a path that has one is the project's own file, so it is
        // integrated or refused like any other rather than silently left out.
        assert!(!is_handoff("src/../.hivra/handoff/task-1.md"));
        assert!(!is_handoff(".hivra/handoff/../config.json"));
    }

    #[test]
    fn the_relative_path_is_the_named_one_whatever_the_platform() {
        // Upstream hard-codes "/" in the path it hands a worker; this one is built with the platform's own separator
        // and is compared after normalising, so a backslash checkout on Windows still finds it.
        assert_eq!(
            relative_path("task-1").unwrap(),
            Path::new(".hivra").join("handoff").join("task-1.md")
        );
    }

    #[test]
    fn a_missing_handoff_is_refused_with_its_reason() {
        let dir = temp("missing");
        let refused = read(&dir.to_string_lossy(), "task-1").unwrap_err();
        assert_eq!(refused.reason, "handoff_missing");
        assert!(refused.message().contains("No handoff file"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_handoff_inside_the_checkout_is_recorded_with_its_digest_and_headings() {
        let dir = temp("inside");
        let body = "## Changed\n- src/a.ts\n\n## Files\nsrc/a.ts\n\n## Checked\n`npx vitest run src/a.test.ts` — 3 passed\n";
        write(&dir, "task-1", body);
        let found = read(&dir.to_string_lossy(), "task-1").unwrap();
        assert_eq!(found.bytes, body.len() as u64);
        assert_eq!(found.headings, vec!["Changed", "Files", "Checked"]);
        assert_eq!(found.missing, vec!["Left"]);
        assert_eq!(found.sha256.len(), 64);
        assert!(found
            .path
            .starts_with(&crate::fs::path_to_js(&crate::fs::canonical(&dir).unwrap())));
        assert!(found.text.contains("src/a.ts"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_heading_is_read_in_either_shape_and_state() {
        assert!(names_heading("## Checked\nx", "Checked"));
        assert!(names_heading("checked:  x", "Checked"));
        assert!(names_heading("### LEFT", "Left"));
        assert!(!names_heading("## Checked off", "Checked"));
        assert!(!names_heading("## Unchanged", "Changed"));
    }

    #[test]
    fn a_handoff_that_points_outside_the_checkout_is_refused() {
        let root = temp("outside-root");
        let checkout = root.join("worker");
        std::fs::create_dir_all(checkout.join(".hivra/handoff")).unwrap();
        let elsewhere = root.join("lead.md");
        std::fs::write(&elsewhere, "## Changed\nnothing").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&elsewhere, checkout.join(".hivra/handoff/task-1.md"))
                .unwrap();
            let refused = read(&checkout.to_string_lossy(), "task-1").unwrap_err();
            assert_eq!(refused.reason, "handoff_outside_checkout");
            assert!(refused.message().contains("outside the worker's checkout"));
        }
        #[cfg(windows)]
        {
            // A Windows equivalent: a file with the same name written elsewhere is never the one that is read,
            // because the path is rebuilt from the canonical checkout every time.
            std::fs::write(root.join("task-1.md"), "## Changed\nnothing").unwrap();
            assert!(read(&checkout.to_string_lossy(), "task-1").is_err());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_handoff_is_found_under_a_checkout_whose_name_holds_spaces_and_unicode() {
        let root = temp("spaces");
        let checkout = root.join("my worktrée");
        std::fs::create_dir_all(&checkout).unwrap();
        write(&checkout, "task-1", "## Changed\nok");
        let found = read(&checkout.to_string_lossy(), "task-1").unwrap();
        assert!(found.path.contains("my worktrée"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_large_handoff_is_read_to_the_cap_and_its_length_is_told_by_metadata() {
        let dir = temp("large");
        let body = format!("## Changed\n{}", "x".repeat(READ_MAX + 500));
        write(&dir, "task-1", &body);
        let found = read(&dir.to_string_lossy(), "task-1").unwrap();
        // The size is the file's own, not the bytes read.
        assert_eq!(found.bytes, body.len() as u64);
        assert!(found.text.len() <= READ_MAX + 4);
        assert!(found.text.ends_with('…'));
        // The digest covers what was read: one byte past the cap at most, never the whole file.
        let head = &body.as_bytes()[..READ_MAX + 1];
        assert_eq!(found.sha256, format!("{:x}", Sha256::digest(head)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sparse_handoff_does_not_pull_its_whole_length_into_memory() {
        // A file that claims two gigabytes but holds almost nothing: the read is bounded, and the size still comes
        // from the file's own metadata.
        let dir = temp("sparse");
        let path = write(&dir, "task-1", "## Changed\nnothing yet");
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(2 * 1024 * 1024 * 1024).unwrap();
        drop(file);
        let started = std::time::Instant::now();
        let found = read(&dir.to_string_lossy(), "task-1").unwrap();
        assert_eq!(found.bytes, 2 * 1024 * 1024 * 1024);
        assert!(found.text.starts_with("## Changed"));
        assert!(found.text.ends_with('…'));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the read should stop at the cap"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
