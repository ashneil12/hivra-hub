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

/// No data folder is not an empty project list. When the sandbox is on, that start is refused. When it is off, the
/// caller's own folders are all there is to lock. A data folder with no database still locks only those.
#[test]
fn a_missing_data_folder_agrees_with_the_sandbox_switch() {
    let extra = std::env::temp_dir().join("hivra-178b-extra");
    let got = with_project_folders(None, std::slice::from_ref(&extra));
    if enabled(None) {
        assert!(
            got.is_err(),
            "the sandbox is on and the data folder is missing, but nothing was locked: {got:?}"
        );
        assert!(
            with_project_folders(None, &[]).is_err(),
            "the sandbox is on and the data folder is missing, but an empty list was allowed"
        );
    } else {
        assert_eq!(got.unwrap(), vec![extra.clone()]);
        assert_eq!(
            with_project_folders(None, &[]).unwrap(),
            Vec::<PathBuf>::new()
        );
    }

    let root = scratch("no database");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let listed = with_project_folders(Some(&data), std::slice::from_ref(&extra)).unwrap();
    assert_eq!(
        listed,
        vec![extra],
        "a data folder with no database must still lock the caller's folders"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// The spec's Limits section names the cap the code enforces, and the point where the profile becomes a file.
#[test]
fn the_spec_limits_name_the_file_cutoff_and_the_byte_cap() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/hivra/work/WP-178-agent-os-sandbox.md");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "the sandbox spec could not be read at {}: {error}",
            path.display()
        )
    });
    let limits = text
        .split("## Limits")
        .nth(1)
        .and_then(|rest| rest.split("\n## ").next())
        .unwrap_or("");
    assert!(
        limits.contains("4,000,000"),
        "the Limits section does not name the 4,000,000 byte cap"
    );
    assert!(
        limits.contains("100,000"),
        "the Limits section does not name the 100,000 byte cutoff"
    );
    assert!(
        limits.contains("-f"),
        "the Limits section does not say a larger profile is passed with -f"
    );
    assert!(
        !limits.contains("900,000"),
        "the Limits section still names the old 900,000 byte cap"
    );
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
