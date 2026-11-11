//! Review r7 repro tests for PR #208 (WP-178), red at e0efac876. Round 7 write-denies the home folders on the login
//! PATH by their spelling, from whatever the login-shell cache holds when the profile is built.

use super::*;

fn filter_matches(line: &str, path: &str) -> bool {
    let Some(start) = line.find("(regex #\"") else {
        return false;
    };
    let rest = &line[start + "(regex #\"".len()..];
    rest.find("\")")
        .is_some_and(|end| regex::Regex::new(&rest[..end]).is_ok_and(|re| re.is_match(path)))
}

fn denies_write(profile: &str, path: &Path) -> bool {
    let path = path.to_string_lossy();
    profile.lines().any(|line| {
        let line = line.trim();
        line.starts_with("(deny ") && line.contains("file-write*") && filter_matches(line, &path)
    })
}

fn scratch(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("hx-r7-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(&dir).unwrap()
}

/// HIGH (r6-4 fix denies a login PATH folder by its spelling only): the kernel checks the resolved path, so a deny on
/// a folder that is a link does nothing. fnm, a common Node manager, puts a per-shell link at the front of PATH
/// (`<state>/fnm_multishells/<pid>_<ms>/bin`, the link pointing at the installed Node version); a personal `~/bin`
/// linked into a dotfiles repo is the same. An agent writes `node` (or `git`) through the link, into the real
/// folder, and Ash's Git panel Commit and Push (`git_with_hooks`, never sandboxed, PATH set to this search path) run
/// it from a hook, ahead of `/usr/bin`. The seeded cache stands for what the login-shell read returns; the scratch
/// folder goes in front, so nothing else resolves differently.
#[test]
fn a_login_path_folder_that_is_a_link_is_write_denied_where_it_points() {
    let home = scratch("fnm");
    let real = home.join(".local/share/fnm/node-versions/v22.11.0/installation");
    std::fs::create_dir_all(real.join("bin")).unwrap();
    std::fs::write(real.join("bin").join("node"), "#!/bin/sh\n").unwrap();
    let state = home.join(".local/state/fnm_multishells");
    std::fs::create_dir_all(&state).unwrap();
    let multishell = state.join("4242_1731300000000");
    std::os::unix::fs::symlink(&real, &multishell).unwrap();
    let entry = multishell.join("bin");
    {
        let mut cache = LOGIN_SHELL_ENV.lock().unwrap();
        let map = cache.get_or_insert_with(HashMap::new);
        let tail = map
            .get("PATH")
            .cloned()
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        map.insert("PATH".into(), format!("{}:{tail}", entry.display()));
    }
    let profile = crate::agent_sandbox::profile_with_checkouts(&home, None, &[]).unwrap();
    let search = cached_gui_search_path();
    let planted = std::fs::canonicalize(entry.join("node")).unwrap();
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        std::env::split_paths(&search).next().as_deref() == Some(entry.as_path()),
        "precondition: the link folder is first on the search path the app's git uses"
    );
    assert!(
        denies_write(&profile, &entry.join("node")),
        "precondition: the folder is denied by its spelling"
    );
    assert!(
        denies_write(&profile, &planted),
        "a write through the linked PATH folder lands at {}, which the profile does not deny",
        planted.display()
    );
}

/// The child half of the next test. It runs alone in its own test process, so the login-shell cache is empty, the
/// way it is at app launch until the first `$SHELL -lic printenv` finishes (and while it runs, `peek_login_shell_path`
/// gets no lock). `SHELL` is a stand-in that prints the login PATH. It is ignored in a normal run; the parent starts it.
#[test]
#[ignore = "run by a_profile_built_before_the_login_path_is_read_still_denies_its_home_folders"]
fn r7_child_profile_before_the_login_read() {
    let home =
        PathBuf::from(std::env::var_os("HIVRA_R7_RACE_HOME").expect("started by the parent test"));
    let volta = home.join(".volta/bin");
    // An agent starts (auto-resume at launch, an armed check, a gate) before the login read has filled the cache.
    // A builder that refuses to start until it has the login PATH is fine too.
    let Ok(profile) = crate::agent_sandbox::profile_with_checkouts(&home, None, &[]) else {
        return;
    };
    // The read the app does anyway (a resolver, Commit and Push). From here on the app's own git searches this PATH.
    let _ = login_shell_path();
    let search = cached_gui_search_path();
    assert!(
        std::env::split_paths(&search).next().as_deref() == Some(volta.as_path()),
        "precondition: the home folder is first on the search path once the read is done: {search}"
    );
    assert!(
        denies_write(&profile, &volta.join("git")),
        "a profile built before the login PATH was read leaves {} writable for the agent's whole run",
        volta.display()
    );
}

/// MED (fails open on timing): `push_searched_home_dirs` reads the login PATH with `peek_login_shell_path`, which
/// returns nothing while the cache is empty and while the read holds the lock. It never waits for the read. A profile
/// built in that window (at launch: auto-resumed turns, armed checks, gates) denies none of the login PATH's home
/// folders, and that sandbox keeps the profile for its whole run, while Ash's Commit and Push later search those
/// folders first. The builder must read the login PATH (or refuse) before it builds.
#[test]
fn a_profile_built_before_the_login_path_is_read_still_denies_its_home_folders() {
    let home = scratch("race");
    let volta = home.join(".volta/bin");
    std::fs::create_dir_all(&volta).unwrap();
    let shell = home.join("login-shell");
    std::fs::write(
        &shell,
        format!("#!/bin/sh\necho 'PATH={}:/usr/bin:/bin'\n", volta.display()),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let exe = std::env::current_exe().unwrap();
    let out = std::process::Command::new(exe)
        .args([
            "--ignored",
            "--exact",
            "harness::review_r7_repro::r7_child_profile_before_the_login_read",
            "--test-threads=1",
            "--nocapture",
        ])
        .env("SHELL", &shell)
        .env("HIVRA_R7_RACE_HOME", &home)
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&home);
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        text.contains("1 passed"),
        "the child did not run as expected, or failed:\n{text}"
    );
    assert!(out.status.success(), "{text}");
}
