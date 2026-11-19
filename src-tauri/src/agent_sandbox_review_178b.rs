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

/// `git()`, `child()`, `contained_command()` and the preflight each store a profile above the inline limit.
/// The same bytes must stay one file, named by their content. A different profile is a second file. A file that
/// does not read back as those bytes, or that is a link, is not used.
#[test]
fn many_calls_with_the_same_large_profile_leave_one_file() {
    let root = scratch("one-file");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let profile = "p".repeat(100_001);

    let mut first = PathBuf::new();
    for n in 0..8 {
        let args = sandbox_exec_profile_args(&profile, Some(&data)).unwrap();
        assert_eq!(args[0], OsString::from("-f"));
        let path = PathBuf::from(&args[1]);
        if n == 0 {
            first = path;
        } else {
            assert_eq!(path, first, "call {n} stored the same profile again");
        }
    }
    let names = profile_dir_names(&data);
    assert_eq!(
        names.len(),
        1,
        "the same profile left more than one file: {names:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&first).unwrap(),
        profile,
        "the stored file is not the profile"
    );
    let expected = content_profile_name(&profile);
    assert_eq!(
        first.file_name().and_then(|name| name.to_str()),
        Some(expected.as_str()),
        "the file is not named by the profile's SHA-256"
    );

    let other = "q".repeat(100_001);
    let second = PathBuf::from(&sandbox_exec_profile_args(&other, Some(&data)).unwrap()[1]);
    assert_ne!(second, first, "a different profile reused the first file");
    assert_eq!(
        profile_dir_names(&data).len(),
        2,
        "a different profile did not keep its own file"
    );

    std::fs::write(&first, "tampered").unwrap();
    let tampered = sandbox_exec_profile_args(&profile, Some(&data));
    assert!(
        tampered.is_err(),
        "a file that does not read back as the profile was reused: {tampered:?}"
    );
    assert_eq!(
        profile_dir_names(&data).len(),
        2,
        "a mismatch wrote another file"
    );

    let stale = data
        .join("sandbox-profiles")
        .join("hivra-sandbox-profile-stale");
    std::fs::write(&stale, "old").unwrap();
    let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(10);
    std::fs::File::options()
        .write(true)
        .open(&stale)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let fresh = data
        .join("sandbox-profiles")
        .join("hivra-sandbox-profile-fresh");
    std::fs::write(&fresh, "new").unwrap();
    // Still inside the hour, so the sweep must keep it. Reuse has to move the age forward or the
    // next hour would drop a profile that is still being used. 120 seconds is wide of any clock step.
    let aged = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(120))
        .unwrap();
    std::fs::File::options()
        .write(true)
        .open(&second)
        .unwrap()
        .set_modified(aged)
        .unwrap();
    sandbox_exec_profile_args(&other, Some(&data)).unwrap();
    assert!(
        !stale.exists(),
        "a profile file older than an hour was kept"
    );
    assert!(
        fresh.exists(),
        "a profile file newer than an hour was swept"
    );
    let refreshed = std::fs::metadata(&second).unwrap().modified().unwrap();
    assert!(refreshed > aged, "reusing a profile left its age unchanged");

    let _ = std::fs::remove_dir_all(&root);
}

/// A link parked on the content name must not be followed, and must not be replaced with the profile.
#[cfg(unix)]
#[test]
fn a_link_in_place_of_the_profile_file_is_not_followed() {
    let root = scratch("profile-link");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let outside = root.join("outside");
    std::fs::write(&outside, "safe").unwrap();
    let profile = "r".repeat(100_001);
    let args = sandbox_exec_profile_args(&profile, Some(&data)).unwrap();
    let path = PathBuf::from(&args[1]);
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    let again = sandbox_exec_profile_args(&profile, Some(&data));
    assert!(
        again.is_err(),
        "a link at the profile name was followed or replaced: {again:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        "safe",
        "the link target was written"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Mode 0600 is part of the reuse check. A wider file is not handed to sandbox-exec.
#[cfg(unix)]
#[test]
fn a_profile_file_that_is_not_private_is_not_reused() {
    let root = scratch("profile-mode");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let profile = "s".repeat(100_001);
    let args = sandbox_exec_profile_args(&profile, Some(&data)).unwrap();
    let path = PathBuf::from(&args[1]);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let again = sandbox_exec_profile_args(&profile, Some(&data));
    assert!(
        again.is_err(),
        "a profile file that is not mode 0600 was reused: {again:?}"
    );
    assert_eq!(
        profile_dir_names(&data).len(),
        1,
        "a wide file was replaced by a second copy"
    );
    let _ = std::fs::remove_dir_all(&root);
}

fn content_profile_name(profile: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(profile.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push(char::from(b"0123456789abcdef"[(byte >> 4) as usize]));
        hex.push(char::from(b"0123456789abcdef"[(byte & 0x0f) as usize]));
    }
    format!("hivra-sandbox-profile-{hex}")
}

fn profile_dir_names(data: &std::path::Path) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(entries) = std::fs::read_dir(data.join("sandbox-profiles")) else {
        return names;
    };
    for entry in entries.flatten() {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    names
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
