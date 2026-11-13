//! PT-5: a project's test debt document on disk: `<app data>/test-debt/<key>.json`, one file per project.
//!
//! Written through a temp file and a rename, so a reader sees the old file or the new one, never half. Read defensively: a file
//! that is missing, too big, not JSON or not a document reads as an empty one (and is set aside, not lost, when something
//! writes over it). A document written by a newer build is read as empty and never written over. Every change goes through
//! `update`, which holds one lock for the whole read, change and write, so two windows (one process) can't overwrite each other's
//! change with a stale read.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::doc::{Doc, VERSION};

const FOLDER: &str = "test-debt";
/// A file bigger than this is not read. The caps in `doc.rs` keep a document well under it.
const MAX_BYTES: u64 = 16 * 1024 * 1024;

/// One lock for every project's document: the writes are small and rare, and one lock cannot deadlock.
fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// The project's key: the same one the testing mode and the ship check use, so a task's gate and the ship check agree on
/// which project they mean.
pub fn key(project: &str) -> String {
    crate::project_file::hash(crate::delivery::settings::key(project).as_bytes())[..16].to_string()
}

pub fn path_of(dir: &Path, project: &str) -> PathBuf {
    dir.join(FOLDER).join(format!("{}.json", key(project)))
}

/// What reading found.
struct Loaded {
    doc: Doc,
    /// The file exists and was written by a newer build.
    newer: bool,
    /// The file exists and is not a document.
    corrupt: bool,
    /// The file could not be read at all (permissions, a disk error, a folder where the file should be): not "nothing there".
    unreadable: Option<String>,
}

fn load(path: &Path) -> Loaded {
    let empty = |newer, corrupt, unreadable| Loaded {
        doc: Doc::default(),
        newer,
        corrupt,
        unreadable,
    };
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        // Nothing there yet: an empty list.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return empty(false, false, None)
        }
        Err(error) => return empty(false, false, Some(error.to_string())),
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return empty(false, true, None);
    }
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        // Not valid text is a document that is not one; any other error is the disk, and the file is left exactly as it is.
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
            return empty(false, true, None)
        }
        Err(error) => return empty(false, false, Some(error.to_string())),
    };
    match serde_json::from_str::<Doc>(&text) {
        Ok(doc) if doc.version > VERSION => empty(true, false, None),
        Ok(doc) => Loaded {
            doc: doc.sane(),
            newer: false,
            corrupt: false,
            unreadable: None,
        },
        Err(_) => empty(false, true, None),
    }
}

/// The project's document as it is on disk. Never fails: what can't be read is an empty document. A caller that must not take an
/// unreadable list for an empty one (a pass, a hold) uses `read_checked`.
pub fn read(dir: &Path, project: &str) -> Doc {
    let _held = lock().lock().unwrap_or_else(|e| e.into_inner());
    load(&path_of(dir, project)).doc
}

/// The document, or why it could not be read: a file the disk would not give (permissions, an I/O error) or one written by a newer
/// build. A file that is missing, or that is not a document, is an empty one (it is the same list as far as anything can tell).
pub fn read_checked(dir: &Path, project: &str) -> Result<Doc, String> {
    let _held = lock().lock().unwrap_or_else(|e| e.into_inner());
    let loaded = load(&path_of(dir, project));
    if let Some(why) = loaded.unreadable {
        return Err(format!(
            "the list of failing tests could not be read: {why}"
        ));
    }
    if loaded.newer {
        return Err(
            "the list of failing tests was written by a newer version of the app".to_string(),
        );
    }
    Ok(loaded.doc)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("the test notes have no folder")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = parent.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let written = (|| -> std::io::Result<()> {
        {
            // Closed before the rename: Windows will not move a file that is still open.
            let mut file = std::fs::File::create(&temp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
        }
        std::fs::rename(&temp, path)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(())
}

/// Moves a file that is not a document aside (`<name>.bad`), so writing a fresh one does not destroy it. Best effort.
fn set_aside(path: &Path) {
    let aside = path.with_extension("bad");
    let _ = std::fs::remove_file(&aside);
    let _ = std::fs::rename(path, aside);
}

/// Reads the document, applies `change` and writes it back, all under the one lock. The file is written only when `change`
/// altered something, and then its `rev` goes up by one. An error from the disk comes back and `change`'s result is lost with
/// it: the caller must not act on a change that was not kept.
pub fn update<R>(
    dir: &Path,
    project: &str,
    change: impl FnOnce(&mut Doc) -> R,
) -> Result<R, String> {
    let _held = lock().lock().unwrap_or_else(|e| e.into_inner());
    let path = path_of(dir, project);
    let loaded = load(&path);
    // A file the disk would not give is never replaced by an empty one: whatever was in it stays where it is.
    if let Some(why) = loaded.unreadable {
        return Err(format!(
            "The test notes for this project could not be read, so nothing was changed: {why}"
        ));
    }
    if loaded.newer {
        return Err(
            "The test notes for this project were written by a newer version of the app, so this version leaves them alone."
                .to_string(),
        );
    }
    let mut doc = loaded.doc;
    let before = doc.clone();
    let result = change(&mut doc);
    if doc != before || loaded.corrupt {
        doc.version = VERSION;
        doc.rev = before.rev.saturating_add(1);
        let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        if loaded.corrupt {
            set_aside(&path);
        }
        write_atomic(&path, &text)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_debt::doc::Candidate;

    fn temp() -> crate::test_debt::testing::Temp {
        crate::test_debt::testing::Temp::new()
    }

    fn cand(name: &str) -> Candidate {
        Candidate {
            runner: "vitest".into(),
            file: "a.test.ts".into(),
            name: name.into(),
            failure: "boom".into(),
            ..Candidate::default()
        }
    }

    #[test]
    fn nothing_on_disk_reads_as_an_empty_list() {
        let dir = temp();
        assert!(read(dir.path(), "/p").items.is_empty());
        assert!(
            !path_of(dir.path(), "/p").exists(),
            "reading writes nothing"
        );
    }

    #[test]
    fn a_change_is_written_whole_and_leaves_no_temp_file_behind() {
        let dir = temp();
        update(dir.path(), "/p", |doc| doc.note_failure(&cand("t"), 5)).unwrap();
        let path = path_of(dir.path(), "/p");
        let text = std::fs::read_to_string(&path).unwrap();
        let doc: Doc = serde_json::from_str(&text).expect("the file is a whole document");
        assert_eq!(doc.items.len(), 1);
        assert_eq!(doc.rev, 1);
        let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "no temp file is left: {names:?}");
        assert!(read(dir.path(), "/p").items.iter().any(|i| i.name == "t"));
    }

    #[test]
    fn a_change_that_alters_nothing_writes_nothing() {
        let dir = temp();
        update(dir.path(), "/p", |_| ()).unwrap();
        assert!(!path_of(dir.path(), "/p").exists());
        update(dir.path(), "/p", |doc| doc.note_failure(&cand("t"), 5)).unwrap();
        update(dir.path(), "/p", |_| ()).unwrap();
        assert_eq!(read(dir.path(), "/p").rev, 1);
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_and_is_set_aside_when_a_write_replaces_it() {
        let dir = temp();
        let path = path_of(dir.path(), "/p");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ this is not json").unwrap();
        assert!(read(dir.path(), "/p").items.is_empty());
        assert!(path.exists(), "reading never moves a file");
        update(dir.path(), "/p", |doc| doc.note_failure(&cand("t"), 5)).unwrap();
        assert_eq!(read(dir.path(), "/p").items.len(), 1);
        assert_eq!(
            std::fs::read_to_string(path.with_extension("bad")).unwrap(),
            "{ this is not json"
        );
    }

    #[test]
    fn a_document_of_the_wrong_shape_reads_as_empty() {
        let dir = temp();
        let path = path_of(dir.path(), "/p");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for text in [
            "[]",
            "null",
            "\"x\"",
            "{\"items\": 5}",
            "{\"items\": [{\"id\": 3}]}",
        ] {
            std::fs::write(&path, text).unwrap();
            assert!(read(dir.path(), "/p").items.is_empty(), "{text}");
        }
    }

    #[test]
    fn a_file_from_a_newer_build_is_read_as_empty_and_never_written_over() {
        let dir = temp();
        let path = path_of(dir.path(), "/p");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let newer = format!("{{\"version\": {}, \"items\": []}}", VERSION + 1);
        std::fs::write(&path, &newer).unwrap();
        assert!(read(dir.path(), "/p").items.is_empty());
        let error = update(dir.path(), "/p", |doc| doc.note_failure(&cand("t"), 5)).unwrap_err();
        assert!(error.contains("newer version"), "{error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_the_disk_will_not_give_is_never_taken_for_an_empty_list_or_written_over() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp();
        update(dir.path(), "/p", |doc| doc.note_failure(&cand("t"), 5)).unwrap();
        let path = path_of(dir.path(), "/p");
        let before = std::fs::read_to_string(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Running as a user that can read it anyway (root) proves nothing here.
        if std::fs::File::open(&path).is_ok() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            return;
        }
        assert!(
            read_checked(dir.path(), "/p").is_err(),
            "an unreadable list is not an empty one"
        );
        let error = update(dir.path(), "/p", |doc| doc.note_failure(&cand("u"), 6)).unwrap_err();
        assert!(error.contains("could not be read"), "{error}");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "nothing was changed"
        );
        assert!(
            !path.with_extension("bad").exists(),
            "and nothing was set aside"
        );
    }

    #[test]
    fn a_missing_file_and_a_file_that_is_not_a_document_read_as_empty_without_error() {
        let dir = temp();
        assert!(read_checked(dir.path(), "/p").unwrap().items.is_empty());
        let path = path_of(dir.path(), "/p");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not json").unwrap();
        assert!(read_checked(dir.path(), "/p").unwrap().items.is_empty());
        std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
        assert!(
            read_checked(dir.path(), "/p").unwrap().items.is_empty(),
            "bytes that are not text"
        );
        std::fs::write(&path, format!("{{\"version\": {}}}", VERSION + 1)).unwrap();
        assert!(
            read_checked(dir.path(), "/p").is_err(),
            "a newer build's file is not an empty list"
        );
    }

    #[test]
    fn a_file_that_is_too_big_is_not_read() {
        let dir = temp();
        let path = path_of(dir.path(), "/p");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let padding = " ".repeat(MAX_BYTES as usize + 1);
        std::fs::write(&path, format!("{{\"items\": []}}{padding}")).unwrap();
        assert!(read(dir.path(), "/p").items.is_empty());
    }

    #[test]
    fn two_writers_never_overwrite_each_others_change() {
        let dir = temp();
        let path = dir.path().to_path_buf();
        let handles: Vec<_> = (0..4)
            .map(|writer| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for n in 0..25 {
                        update(&path, "/p", |doc| {
                            doc.note_failure(&cand(&format!("w{writer}-{n}")), 1)
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let doc = read(dir.path(), "/p");
        assert_eq!(doc.items.len(), 100, "every writer's change is kept");
        assert_eq!(doc.rev, 100);
    }

    #[test]
    fn projects_have_their_own_files_and_a_path_with_spaces_and_unicode_works() {
        let dir = temp();
        update(dir.path(), "/work/my app é", |doc| {
            doc.note_failure(&cand("t"), 1)
        })
        .unwrap();
        assert_eq!(read(dir.path(), "/work/my app é").items.len(), 1);
        assert!(read(dir.path(), "/work/other").items.is_empty());
        assert_ne!(key("/work/a"), key("/work/b"));
    }
}
