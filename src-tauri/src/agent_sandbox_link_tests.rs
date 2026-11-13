//! SC-6f: one plain example for each bug the SC-6 property tests found in the agent sandbox's link and path rules
//! (`agent_sandbox_prop_tests.rs` holds the general rule and the shrunk cases; these pin the failing shapes by hand).
//! Unix only, since they make real symlinks. Only the profile text is judged: no sandbox is started.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

static SCRATCH: AtomicUsize = AtomicUsize::new(0);

/// A temporary folder (canonical, so macOS's `/var` link is already resolved) removed when it goes out of scope.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "sc6f-sandbox-{}-{}",
            std::process::id(),
            SCRATCH.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(&path).unwrap())
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Whether some deny line names `op` and its regex matches `path` (every path rule in the profile is a regex).
fn denies(profile: &str, op: &str, path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    profile.lines().map(str::trim).any(|line| {
        let Some(ops) = line.strip_prefix("(deny ") else {
            return false;
        };
        let Some(start) = line.find("(regex #\"") else {
            return false;
        };
        let rest = &line[start + "(regex #\"".len()..];
        let Some(end) = rest.find("\"))") else {
            return false;
        };
        ops.split(" (regex")
            .next()
            .unwrap_or("")
            .split(' ')
            .any(|word| word == op)
            && regex::Regex::new(&rest[..end]).is_ok_and(|re| re.is_match(text))
    })
}

/// A write and a hard link are the two ways to change a protected place.
fn write_denied(profile: &str, path: &Path) -> bool {
    denies(profile, "file-write*", path) && denies(profile, "file-link", path)
}

fn profile(home: &Path, checkouts: &[PathBuf]) -> Result<String, String> {
    profile_with_checkouts(home, None, checkouts)
}

// ---- bug 3: a link target the profile cannot quote ------------------------------------------------------------------

/// A link whose target has a quote, a backslash or a control character cannot be written into the profile, and leaving
/// its deny out leaves the place writable by that name. The profile is refused, as it is for a home that cannot be
/// quoted, whichever rule met the link: a secret file, a secret folder, a shell profile folder, a file a shell profile
/// sources. A target that is only odd (spaces, brackets, unicode) still makes a profile that denies it.
#[test]
fn a_link_target_the_profile_cannot_quote_refuses_the_profile() {
    for bad in ['"', '\\', '\n', '\t', '\u{7}'] {
        let hostile = format!("t{bad}x");
        // A secret file, a secret folder and a shell profile folder, each the link to a hostile name.
        for (place, is_dir) in [
            (".netrc", false),
            (".ssh", true),
            (".config/fish/conf.d", true),
        ] {
            let scratch = Scratch::new();
            let home = scratch.dir("home");
            let real = scratch.dir("dotfiles").join(&hostile);
            if is_dir {
                fs::create_dir_all(&real).unwrap();
            } else {
                fs::write(&real, b"").unwrap();
            }
            let at = home.join(place);
            fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&real, &at).unwrap();
            let refused = profile(&home, &[]);
            assert!(
                refused.as_ref().is_err_and(|e| e.contains("cannot quote")),
                "{place} links to a name with {bad:?} in it and the profile was not refused: {:?}",
                refused.map(|text| text.len())
            );
        }
        // A file a login shell sources, named by `.zshrc`.
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        let real = scratch.dir("dotfiles").join(&hostile);
        fs::write(&real, b"").unwrap();
        scratch.dir("home/rc");
        std::os::unix::fs::symlink(&real, home.join("rc/extra.zsh")).unwrap();
        fs::write(home.join(".zshrc"), "source ~/rc/extra.zsh\n").unwrap();
        let refused = profile(&home, &[]);
        assert!(
            refused.as_ref().is_err_and(|e| e.contains("cannot quote")),
            "a sourced file links to a name with {bad:?} in it and the profile was not refused: {:?}",
            refused.map(|text| text.len())
        );
    }

    // Control: an odd but quotable target is denied, not refused.
    let scratch = Scratch::new();
    let home = scratch.dir("home");
    let real = scratch.dir("dotfiles").join("日本語 (v2) [x]+.y");
    fs::write(&real, b"").unwrap();
    std::os::unix::fs::symlink(&real, home.join(".netrc")).unwrap();
    let text = profile(&home, &[]).expect("an odd but quotable target makes a profile");
    assert!(write_denied(&text, &real));
}
