//! WP-178 follow-up. The -f profile file must sit in the write-denied data folder.

use std::ffi::OsString;
use std::path::PathBuf;

use super::*;

fn scratch(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "agent-sandbox-178b-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    crate::fs::canonical(&dir).unwrap()
}

fn profile_denies_write(profile: &str, path: &str) -> bool {
    profile.lines().any(|line| {
        let line = line.trim();
        if !line.starts_with("(deny ") || !line.contains("file-write*") {
            return false;
        }
        let Some(start) = line.find("(regex #\"") else {
            return false;
        };
        let rest = &line[start + "(regex #\"".len()..];
        let Some(end) = rest.find("\"))") else {
            return false;
        };
        regex::Regex::new(&rest[..end]).is_ok_and(|re| re.is_match(path))
    })
}

/// A profile above the inline limit is passed with `-f`. The file has to be inside the data folder the profile
/// write-denies. `$TMPDIR` is not denied, so a sandboxed agent can replace the file before `sandbox-exec` reads it.
#[test]
fn a_large_profile_file_stays_inside_the_write_denied_data_folder() {
    let root = scratch("profile file");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();

    let inline = "x".repeat(100_000);
    let small = sandbox_exec_profile_args(&inline, Some(&data)).unwrap();
    assert_eq!(
        small[0],
        OsString::from("-p"),
        "100,000 bytes still fits in -p"
    );

    let oversized = "x".repeat(100_001);
    let args = sandbox_exec_profile_args(&oversized, Some(&data)).unwrap();
    assert_eq!(args[0], OsString::from("-f"));
    let path = PathBuf::from(&args[1]);
    let written = crate::fs::canonical(&path).unwrap();
    let data = crate::fs::canonical(&data).unwrap();
    assert!(
        written.starts_with(&data),
        "the profile file is not inside the data folder: {written:?}"
    );
    let text = std::fs::read_to_string(&written).unwrap();
    assert_eq!(
        text, oversized,
        "the file is not the profile that was passed"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&written).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "the profile file is not private, mode {mode:o}"
        );
    }

    let profile = profile_with_checkouts(&home, Some(&data), &[]).unwrap();
    let path_text = written.to_string_lossy().into_owned();
    assert!(
        profile_denies_write(&profile, &path_text),
        "a sandboxed agent can write the profile file at {path_text}"
    );

    #[cfg(unix)]
    {
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link = data.join("sandbox-profiles");
        if link.exists() {
            let _ = std::fs::remove_dir_all(&link);
        }
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let linked = sandbox_exec_profile_args(&oversized, Some(&data));
        let leaked = std::fs::read_dir(&outside).unwrap().count();
        assert_eq!(
            leaked, 0,
            "the profile was written through a link out of the data folder"
        );
        assert!(
            linked.is_err(),
            "a profile directory that is a link was accepted: {linked:?}"
        );
    }

    let before = temp_profile_names();
    let missing = sandbox_exec_profile_args(&oversized, None);
    assert!(
        missing.is_err(),
        "a large profile with no data folder must not start, got {missing:?}"
    );
    assert_eq!(
        temp_profile_names(),
        before,
        "a large profile was written into the temp directory"
    );

    let _ = std::fs::remove_dir_all(&root);
}

fn temp_profile_names() -> Vec<String> {
    let mut names = Vec::new();
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return names;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("hivra-sandbox-profile-") {
            names.push(name);
        }
    }
    names.sort();
    names
}
