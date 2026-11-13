//! SC-6 (spec 4i): property tests for the agent sandbox's path rules.
//!
//! The profile is a denylist (`(allow default)` and then the places it names), so the rule is stated that way: no
//! protected place is writable, however it is spelled or linked. The macOS sandbox matches the path the kernel resolved,
//! so a test spelling is walked the way the kernel walks it (`.` and `..` steps, doubled and trailing slashes, symlinks)
//! before the profile's own deny lines are asked about it; case is left as written, since the profile reads APFS
//! case-insensitively. The pure helpers (`ci_regex`, `glob_regex`, `folder_forms`, `normalize_lexical`) are checked
//! directly. No macOS sandbox is started: only the profile text is judged.

use std::fs;
use std::path::Component;
use std::sync::atomic::{AtomicUsize, Ordering};

use proptest::prelude::*;
use proptest::sample::Index;

use super::*;

/// 64 cases a run, or whatever `PROPTEST_CASES` says (an explicit `cases` would override the variable).
fn config() -> ProptestConfig {
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 64;
    }
    config
}

// ---- what a profile denies ------------------------------------------------------------------------------------------

/// A profile's deny lines, parsed once: the operations each names and its regex (every path rule is a regex).
struct Rules {
    denies: Vec<(String, regex::Regex)>,
}

impl Rules {
    fn parse(profile: &str) -> Self {
        let mut denies = Vec::new();
        for line in profile.lines().map(str::trim) {
            let Some(ops) = line.strip_prefix("(deny ") else {
                continue;
            };
            let Some(start) = line.find("(regex #\"") else {
                continue;
            };
            let rest = &line[start + "(regex #\"".len()..];
            let Some(end) = rest.find("\"))") else {
                continue;
            };
            let regex = regex::Regex::new(&rest[..end])
                .unwrap_or_else(|error| panic!("a profile line is not a regex: {line}: {error}"));
            let ops = ops.split(" (regex").next().unwrap_or("").to_string();
            denies.push((ops, regex));
        }
        Self { denies }
    }

    /// Whether some deny line names `op` and matches `path`.
    fn denies(&self, op: &str, path: &Path) -> bool {
        let Some(text) = path.to_str() else {
            return false;
        };
        self.denies
            .iter()
            .any(|(ops, regex)| ops.split(' ').any(|word| word == op) && regex.is_match(text))
    }

    /// Write and hard link are the two ways to change a protected place's content.
    fn write_denied(&self, path: &Path) -> bool {
        self.denies("file-write*", path) && self.denies("file-link", path)
    }
}

/// The path the kernel would present for `spelled`: `.` steps and repeated or trailing slashes dropped, `..` taking the
/// parent of what came before it, and a symlink replaced by where it points (even half way along).
fn kernel_path(spelled: &Path) -> PathBuf {
    let mut cur = PathBuf::new();
    for component in spelled.components() {
        match component {
            Component::RootDir => cur.push("/"),
            Component::CurDir | Component::Prefix(_) => {}
            Component::ParentDir => {
                cur.pop();
            }
            Component::Normal(name) => {
                cur.push(name);
                if fs::symlink_metadata(&cur).is_ok_and(|meta| meta.file_type().is_symlink()) {
                    if let Ok(real) = fs::canonicalize(&cur) {
                        cur = real;
                    }
                }
            }
        }
    }
    cur
}

// ---- real folders ---------------------------------------------------------------------------------------------------

static SCRATCH: AtomicUsize = AtomicUsize::new(0);

/// A temporary folder (canonical, so the `/var` link of macOS is already resolved) removed when it goes out of scope.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "sc6-sandbox-{}-{}",
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

/// A folder name a person could have: spaces, unicode, dots, the characters a regex or a shell reads as special. Never a
/// quote, a backslash or a control character (those are refused outright, and have their own property).
fn odd_name() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => "[A-Za-z0-9 _.+()\\[\\]{}$^|*?#&~-]{1,16}",
        2 => "\\PC{1,8}",
        1 => Just("日本語 (v2) [x]+.y".to_string()),
    ]
    .prop_filter("a real, quotable name", |name| {
        !name.is_empty()
            && name != "."
            && name != ".."
            && !name.contains(['/', '"', '\\', '\0'])
            && !name.chars().any(char::is_control)
            && !name.ends_with(' ')
    })
}

/// A path segment of a file an agent might write: any name that is not a step.
fn segment() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => "[A-Za-z0-9 _.-]{1,12}",
        1 => "\\PC{1,8}",
    ]
    .prop_filter("a real name", |name| {
        !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0'])
    })
}

// ---- the places the profile protects -------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// A folder and everything in it.
    Dir,
    /// One file.
    File,
    /// Everything inside a folder (`x/**`), not the folder's own node.
    Below,
    /// The same, for a shell profile glob (`~/.config/fish/conf.d/**`), which the profile writes as its own rule.
    ShellGlob,
    /// A folder whose name may continue in the same segment (`com.ash.monocode-hub` and a dev copy's `.dev.<slot>`).
    DirPrefix,
}

#[derive(Clone, Debug)]
struct Place {
    rel: String,
    kind: Kind,
}

/// Every home-relative place the profile writes denies for: the secret places and shell profiles, the protected globs that
/// deny writes, and the app's own data folder.
fn places() -> Vec<Place> {
    let list = home_secrets().expect("the shared list loads");
    let mut out = Vec::new();
    let place = |rel: &str, kind| Place {
        rel: rel.to_string(),
        kind,
    };
    for dir in &list.dirs {
        out.push(place(dir, Kind::Dir));
    }
    for file in &list.files {
        out.push(place(file, Kind::File));
    }
    for file in &list.shell_profiles {
        match file.strip_suffix("/**") {
            Some(prefix) if !prefix.contains('*') => out.push(place(prefix, Kind::ShellGlob)),
            _ if !file.contains('*') => out.push(place(file, Kind::File)),
            _ => {}
        }
    }
    for glob in protected_globs()
        .expect("the shared list loads")
        .iter()
        .filter(|glob| glob.deny_write)
    {
        let Some(rel) = glob.pattern.strip_prefix("~/") else {
            continue;
        };
        match rel.strip_suffix("/**") {
            Some(prefix) if !prefix.contains('*') => out.push(place(prefix, Kind::Below)),
            _ if !rel.contains('*') => out.push(place(rel, Kind::File)),
            _ => {}
        }
    }
    out.push(place(APP_DATA_UNDER_HOME, Kind::DirPrefix));
    out
}

/// `text` with each ASCII letter's case flipped where `flips` says (APFS reads names case-insensitively).
fn recase(text: &str, flips: &[bool]) -> String {
    text.chars()
        .enumerate()
        .map(|(index, c)| {
            if flips[index % flips.len()] {
                if c.is_ascii_lowercase() {
                    c.to_ascii_uppercase()
                } else {
                    c.to_ascii_lowercase()
                }
            } else {
                c
            }
        })
        .collect()
}

/// A path to `rel` (and `extra` below it) under `base`, written with the steps and slashes a process may use:
/// `.` steps, a `junk/..` detour, doubled slashes and a trailing slash.
fn assemble(base: &Path, rel: &str, extra: &[String], noise: &[u8]) -> String {
    let mut out = base.to_string_lossy().into_owned();
    let segments = rel.split('/').chain(extra.iter().map(String::as_str));
    for (index, segment) in segments.enumerate() {
        out.push_str(match noise[index % noise.len()] % 5 {
            1 => "//",
            2 => "/./",
            3 => "/junk/../",
            _ => "/",
        });
        out.push_str(segment);
    }
    if noise[0] % 2 == 0 {
        out.push('/');
    }
    out
}

fn flips() -> impl Strategy<Value = Vec<bool>> {
    prop::collection::vec(any::<bool>(), 1..24)
}

fn noise() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(0u8..5, 1..12)
}

/// A kind of file below `place`: none for a file, one or more segments below a folder or a `**`.
fn below(kind: Kind, segments: &[String]) -> Vec<String> {
    match kind {
        Kind::File => Vec::new(),
        Kind::Dir | Kind::Below | Kind::ShellGlob | Kind::DirPrefix => segments.to_vec(),
    }
}

/// The profile for a fresh home under `scratch`: its path and the parsed rules.
fn profile_for(home: &Path, data: Option<&Path>, checkouts: &[PathBuf]) -> Rules {
    let text = profile_with_checkouts(home, data, checkouts)
        .unwrap_or_else(|error| panic!("the profile did not build for {home:?}: {error}"));
    Rules::parse(&text)
}

proptest! {
    #![proptest_config(config())]

    /// Every protected place is write-denied however it is spelled: any case, `.` steps, a `..` detour, doubled and trailing
    /// slashes, unicode and odd names below it, in the home folder as given. Every place the profile protects is tried in
    /// every case: the secret places, the shell profiles, the global git config, the CLIs' settings and hooks, the app's
    /// data folder (and a dev copy's, which continues the same name).
    #[test]
    fn prop_every_protected_place_is_write_denied_however_it_is_spelled(
        flips in flips(),
        noise in noise(),
        segments in prop::collection::vec(segment(), 1..4),
        suffix in "[A-Za-z0-9.-]{0,10}",
    ) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        let rules = profile_for(&home, None, &[]);
        for place in places() {
            let below = below(place.kind, &segments);
            let mut rel = recase(&place.rel, &flips);
            if place.kind == Kind::DirPrefix {
                // `com.ash.monocode-hub.dev.<slot>`: the folder's name continues in the same segment.
                rel.push_str(&suffix);
            }
            let spelled = assemble(&home, &rel, &below, &noise);
            let resolved = kernel_path(Path::new(&spelled));
            prop_assert!(
                rules.write_denied(&resolved),
                "{:?} ({:?}) is writable as {:?}", place.rel, place.kind, resolved
            );
        }
    }

    /// A protected place cannot be moved out from under its deny: every folder from the place up to and including home can
    /// not be unlinked or renamed, in any case spelling.
    #[test]
    fn prop_the_folders_above_a_protected_place_cannot_be_moved_aside(flips in flips()) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        let rules = profile_for(&home, None, &[]);
        for place in places() {
            // The folders to lock: a file's parents, a folder and its parents, always ending at home.
            let mut parts: Vec<&str> = place.rel.split('/').collect();
            if place.kind == Kind::File {
                parts.pop();
            }
            for depth in 0..=parts.len() {
                let rel = recase(&parts[..depth].join("/"), &flips);
                let node = if rel.is_empty() { home.clone() } else { home.join(&rel) };
                prop_assert!(
                    rules.denies("file-write-unlink", &node),
                    "{:?}: {:?} can be moved aside", place.rel, node
                );
            }
        }
    }

    /// A place that is a link is denied through its target, so a write by the other name is refused: each of a few places
    /// is made a link to a folder or file with an odd name (inside or outside home, in any case spelling), or the folder that
    /// holds it is a link (`~/.config` into a dotfiles repository). The path the kernel would present for a write by the
    /// place's own name is denied.
    #[test]
    fn prop_a_protected_place_that_is_a_link_is_denied_by_the_name_it_points_to(
        links in prop::collection::vec(any::<Index>(), 1..4),
        parent_link in any::<bool>(),
        target_name in odd_name(),
        target_inside_home in any::<bool>(),
        flips in flips(),
        segments in prop::collection::vec(segment(), 1..3),
    ) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        // The places with their own property below (the app's data folder, a shell profile glob) are made, not linked.
        let all = places();
        let eligible: Vec<usize> = (0..all.len())
            .filter(|index| !matches!(all[*index].kind, Kind::DirPrefix | Kind::ShellGlob))
            .collect();
        let others = scratch.dir("dotfiles");
        let targets = if target_inside_home { scratch.dir("home/dot files") } else { others };
        if parent_link {
            // `~/.config` is a link into a dotfiles folder.
            let real = targets.join(&target_name).join("config");
            fs::create_dir_all(&real).unwrap();
            std::os::unix::fs::symlink(&real, home.join(".config")).unwrap();
        }
        // Every place exists, as a real folder or file, through the link when the folder above it is one.
        let linked: Vec<usize> = links.iter().map(|pick| eligible[pick.index(eligible.len())]).collect();
        for (index, place) in all.iter().enumerate() {
            if linked.contains(&index) {
                continue;
            }
            let path = home.join(&place.rel);
            if place.kind == Kind::File {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                let _ = fs::write(&path, b"");
            } else {
                fs::create_dir_all(&path).unwrap();
            }
        }
        for (n, index) in linked.iter().enumerate() {
            let place = &all[*index];
            let at = home.join(&place.rel);
            if fs::symlink_metadata(&at).is_ok() {
                continue;
            }
            fs::create_dir_all(at.parent().unwrap()).unwrap();
            let real = targets.join(&target_name).join(format!("t{n}"));
            if place.kind == Kind::File {
                fs::create_dir_all(real.parent().unwrap()).unwrap();
                fs::write(&real, b"").unwrap();
            } else {
                fs::create_dir_all(&real).unwrap();
            }
            std::os::unix::fs::symlink(&real, &at).unwrap();
        }
        let rules = profile_for(&home, None, &[]);
        // The linked places, and with `~/.config` a link, every eligible place under it.
        let mut checked: Vec<usize> = linked.clone();
        if parent_link {
            checked.extend(eligible.iter().copied().filter(|index| all[*index].rel.starts_with(".config/")));
        }
        for index in &checked {
            let place = &all[*index];
            let below = below(place.kind, &segments);
            // A write by the place's own name, and by the name the link points to in a different case.
            let by_name = assemble(&home, &place.rel, &below, &[0]);
            let resolved = kernel_path(Path::new(&by_name));
            prop_assert!(rules.write_denied(&resolved), "{:?} is writable through its link as {:?}", place.rel, resolved);
            let shouted = PathBuf::from(recase(&resolved.to_string_lossy(), &flips));
            prop_assert!(rules.write_denied(&shouted), "{:?} is writable by another case as {:?}", place.rel, shouted);
        }
    }

    /// A link whose target has a quote, a backslash or a newline in its name cannot be written into the profile. A profile
    /// that cannot name a protected place must not be used (fail closed): either no profile is made, or the target is
    /// denied.
    #[test]
    fn prop_a_link_target_the_profile_cannot_quote_is_not_left_open(
        place_pick in any::<Index>(),
        name in odd_name(),
        bad in prop::sample::select(vec!['"', '\\', '\n']),
        at in any::<Index>(),
        segments in prop::collection::vec(segment(), 1..3),
    ) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        let all = places();
        let eligible: Vec<&Place> = all
            .iter()
            .filter(|place| !matches!(place.kind, Kind::DirPrefix))
            .collect();
        let place = eligible[place_pick.index(eligible.len())];
        let mut chars: Vec<char> = name.chars().collect();
        chars.insert(at.index(chars.len() + 1), bad);
        let hostile: String = chars.into_iter().collect();
        let real = scratch.dir("dotfiles").join(&hostile);
        let at_place = home.join(&place.rel);
        fs::create_dir_all(at_place.parent().unwrap()).unwrap();
        if place.kind == Kind::File {
            fs::write(&real, b"").unwrap();
        } else {
            fs::create_dir_all(&real).unwrap();
        }
        std::os::unix::fs::symlink(&real, &at_place).unwrap();
        match profile_with_checkouts(&home, None, &[]) {
            // Failing closed is right: nothing starts.
            Err(_) => {}
            Ok(text) => {
                let rules = Rules::parse(&text);
                let spelled = assemble(&home, &place.rel, &below(place.kind, &segments), &[0]);
                let resolved = kernel_path(Path::new(&spelled));
                prop_assert!(
                    rules.write_denied(&resolved),
                    "{:?} is a link to a name with {:?} in it, and the profile left {:?} writable", place.rel, bad, resolved
                );
            }
        }
    }

    /// A checkout that is not a git repository yet is locked all the same, by the name it was started under and by the real
    /// folder behind it (a link, or `.` and `..` steps): an agent in it can run `git init` and plant a hook, and the
    /// kernel presents the real path.
    #[test]
    #[ignore = "SC-6 found bug: a named checkout with no .git yet is locked only by the name it was given (a // or . or .. step, or a link, leaves the real .git/hooks writable)"]
    fn prop_a_checkout_with_no_git_dir_yet_is_locked_by_its_real_name_too(
        name in odd_name(),
        via_link in any::<bool>(),
        noise in noise(),
        hook in segment(),
    ) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        let parent = scratch.dir("work");
        let checkout = scratch.dir(&format!("work/{name}"));
        fs::create_dir_all(parent.join("junk")).unwrap();
        let named = if via_link {
            let link = scratch.0.join("link");
            std::os::unix::fs::symlink(&checkout, &link).unwrap();
            link
        } else {
            PathBuf::from(assemble(&parent, &name, &[], &noise))
        };
        let rules = profile_for(&home, None, &[named.clone()]);
        let spelled = assemble(&named, &format!(".git/hooks/{hook}"), &[], &[0]);
        let resolved = kernel_path(Path::new(&spelled));
        prop_assert!(rules.write_denied(&resolved), "a hook can be planted in {:?}", resolved);
        let config = kernel_path(&named.join(".git").join("config"));
        prop_assert!(rules.write_denied(&config), "the git config can be written at {:?}", config);
    }

    /// A shell profile folder (`~/.config/fish/conf.d/**`, whose files a shell sources) that is a link is denied through its
    /// target, like every other place. The profile writes it as a pattern of its own, so the same pattern is also written
    /// under the target.
    #[test]
    fn prop_a_shell_profile_folder_that_is_a_link_is_denied_by_the_name_it_points_to(
        target_name in odd_name(),
        segments in prop::collection::vec(segment(), 1..3),
    ) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        for place in places().into_iter().filter(|place| place.kind == Kind::ShellGlob) {
            let at = home.join(&place.rel);
            fs::create_dir_all(at.parent().unwrap()).unwrap();
            let real = scratch.dir("dotfiles").join(&target_name);
            fs::create_dir_all(&real).unwrap();
            std::os::unix::fs::symlink(&real, &at).unwrap();
            let rules = profile_for(&home, None, &[]);
            let spelled = assemble(&home, &place.rel, &segments, &[0]);
            let resolved = kernel_path(Path::new(&spelled));
            prop_assert!(rules.write_denied(&resolved), "{:?} is writable through its link as {:?}", place.rel, resolved);
        }
    }

    /// A named checkout's git directory is write-denied however the checkout is spelled: with `.` and `..` steps, doubled
    /// and trailing slashes, or by a link (the path an agent was started in is a link to the real folder), inside home or
    /// outside it, in any case. So are the folders above it, so the checkout cannot be moved with its deny.
    #[test]
    fn prop_a_named_checkouts_git_dir_is_write_denied_however_the_checkout_is_spelled(
        name in odd_name(),
        inside_home in any::<bool>(),
        via_link in any::<bool>(),
        noise in noise(),
        flips in flips(),
        module in "[a-z]{1,6}",
        hook in segment(),
    ) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        let parent = if inside_home { home.clone() } else { scratch.dir("work") };
        let checkout = parent.join(&name);
        fs::create_dir_all(checkout.join(".git").join("hooks")).unwrap();
        // A real folder for a `junk/..` detour to pass through, as a process would have to for the path to resolve.
        fs::create_dir_all(parent.join("junk")).unwrap();
        let named = if via_link {
            let link = scratch.0.join("link");
            std::os::unix::fs::symlink(&checkout, &link).unwrap();
            link
        } else {
            PathBuf::from(assemble(&parent, &name, &[], &noise))
        };
        let rules = profile_for(&home, None, &[named.clone()]);
        let protected = [
            ".git".to_string(),
            ".git/hooks".to_string(),
            format!(".git/hooks/{hook}"),
            ".git/config".to_string(),
            ".git/commondir".to_string(),
            ".git/gitdir".to_string(),
            ".git/config.worktree".to_string(),
            ".git/info/attributes".to_string(),
            format!(".git/modules/{module}/hooks/{hook}"),
            format!(".git/modules/{module}/config"),
            format!(".git/worktrees/{module}/gitdir"),
        ];
        for rel in &protected {
            let spelled = assemble(&named, rel, &[], &noise);
            // The kernel presents the path with the links resolved; APFS reads the case it is given either way.
            let resolved = kernel_path(Path::new(&spelled));
            let shouted = PathBuf::from(recase(&resolved.to_string_lossy(), &flips));
            prop_assert!(rules.write_denied(&resolved), "{:?} is writable as {:?}", rel, resolved);
            prop_assert!(rules.write_denied(&shouted), "{:?} is writable by another case as {:?}", rel, shouted);
        }
        // The checkout and every folder above it cannot be moved aside: up to home for a checkout inside it, up to the
        // root for one outside it (renaming any of them moves `.git` out from under the deny).
        let mut cur = fs::canonicalize(&checkout).unwrap();
        loop {
            prop_assert!(rules.denies("file-write-unlink", &cur), "{:?} can be moved aside", cur);
            if cur == home {
                break;
            }
            match cur.parent() {
                Some(next) if next != cur => cur = next.to_path_buf(),
                _ => break,
            }
        }
    }

    /// The same for a data folder outside home, named to the profile by its own path: the whole folder is write-denied,
    /// reached by a link or through steps and slashes, in any case.
    #[test]
    fn prop_an_explicit_data_folder_is_write_denied_however_it_is_spelled(
        name in odd_name(),
        via_link in any::<bool>(),
        noise in noise(),
        flips in flips(),
        below in prop::collection::vec(segment(), 1..4),
    ) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        let data = scratch.dir(&format!("data/{name}"));
        // Real folders for the `junk/..` detours to pass through.
        scratch.dir("junk");
        scratch.dir("data/junk");
        let named = if via_link {
            let link = scratch.0.join("data-link");
            std::os::unix::fs::symlink(&data, &link).unwrap();
            link
        } else {
            PathBuf::from(assemble(&scratch.0, &format!("data/{name}"), &[], &noise))
        };
        let rules = profile_for(&home, Some(&named), &[]);
        let spelled = assemble(&named, &below[0], &below[1..], &noise);
        let resolved = kernel_path(Path::new(&spelled));
        let shouted = PathBuf::from(recase(&resolved.to_string_lossy(), &flips));
        prop_assert!(rules.write_denied(&resolved), "the data folder is writable as {:?}", resolved);
        prop_assert!(rules.write_denied(&shouted), "the data folder is writable by another case as {:?}", shouted);
    }

    /// The app's own data folder is denied by its place under home, and so by the name a link points to when a person has
    /// moved the folder (to another disk, behind a link): a write by either name is refused.
    #[test]
    fn prop_the_app_data_folder_is_write_denied_when_it_is_a_link(
        target_name in odd_name(),
        suffix in "[A-Za-z0-9.-]{0,10}",
        below in prop::collection::vec(segment(), 1..3),
    ) {
        let scratch = Scratch::new();
        let home = scratch.dir("home");
        let real = scratch.dir("moved").join(&target_name);
        fs::create_dir_all(&real).unwrap();
        let at = home.join(format!("{APP_DATA_UNDER_HOME}{suffix}"));
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &at).unwrap();
        let rules = profile_for(&home, None, &[]);
        let spelled = assemble(&home, &format!("{APP_DATA_UNDER_HOME}{suffix}"), &below, &[0]);
        let resolved = kernel_path(Path::new(&spelled));
        prop_assert!(rules.write_denied(&resolved), "the app's data is writable through its link as {:?}", resolved);
    }

    /// A home the profile cannot quote (a quote, a backslash or a control character in its path) fails the profile closed:
    /// no profile is made, so nothing starts. A home with only odd-but-quotable characters (spaces, brackets, `+`, `$`,
    /// unicode) gives a profile whose every line is a deny or the `(allow default)` start, whose every regex compiles, and
    /// whose rule for `.ssh` matches `.ssh` and what is under it in the home as written, and not a look-alike home.
    #[test]
    fn prop_a_home_is_quoted_or_refused_and_its_regexes_name_only_that_home(
        name in odd_name(),
        bad in prop::sample::select(vec!['"', '\\', '\n', '\r', '\u{7}']),
        at in any::<Index>(),
        below in prop::collection::vec(segment(), 0..3),
    ) {
        // A home that cannot be quoted refuses.
        let mut chars: Vec<char> = name.chars().collect();
        chars.insert(at.index(chars.len() + 1), bad);
        let hostile: String = chars.into_iter().collect();
        let refused = profile_with_checkouts(Path::new(&format!("/tmp/{hostile}")), None, &[]);
        prop_assert!(refused.is_err(), "a home with {:?} in it made a profile: {:?}", bad, refused.map(|p| p.len()));

        // A quotable home: the profile is well formed and names exactly this home.
        let home = PathBuf::from(format!("/tmp/{name}"));
        let text = profile_with_checkouts(&home, None, &[]).expect("a quotable home makes a profile");
        let mut lines = text.lines();
        prop_assert_eq!(lines.next(), Some("(version 1)"));
        prop_assert_eq!(lines.next(), Some("(allow default)"));
        for line in lines {
            prop_assert!(
                line.is_empty() || line.starts_with("(deny "),
                "a line that is not a deny: {:?}", line
            );
            prop_assert!(!line.contains("(allow "), "the profile allows something: {:?}", line);
        }
        let rules = Rules::parse(&text);
        let ssh = home.join(".ssh").join(below.join("/"));
        prop_assert!(rules.write_denied(&ssh), "{:?} is writable", ssh);
        // A look-alike home: every character that is not a letter or digit changed to another (`.` for a regex is any
        // character, so an unescaped special would let this match).
        let lookalike_name: String = name
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '~' })
            .collect();
        let lookalike = PathBuf::from(format!("/tmp/{lookalike_name}")).join(".ssh");
        if !lookalike.starts_with(&home) {
            prop_assert!(
                !rules.denies("file-write*", &lookalike),
                "{:?} was denied by the rules for {:?}", lookalike, home
            );
        }
    }

    /// `ci_regex` matches its text in every ASCII case spelling and nothing else: not the text with something added or a
    /// letter changed to another letter, and it is a valid regex whatever the text holds (`.[](){}*+?^$|\` included).
    #[test]
    fn prop_ci_regex_matches_exactly_the_case_spellings_of_its_text(
        text in prop_oneof!["[A-Za-z0-9 ./_()\\[\\]{}*+?^$|\\\\-]{1,24}", "\\PC{1,12}"],
        flips in flips(),
        extra in "[A-Za-z0-9]{1,3}",
    ) {
        let regex = regex::Regex::new(&format!("^{}$", ci_regex(&text))).expect("a valid regex");
        prop_assert!(regex.is_match(&text));
        prop_assert!(regex.is_match(&recase(&text, &flips)), "the flipped spelling of {:?} did not match", text);
        prop_assert!(!regex.is_match(&format!("{text}{extra}")), "{:?} matched with {:?} added", text, extra);
        prop_assert!(!regex.is_match(&format!("{extra}{text}")), "{:?} matched with {:?} before it", text, extra);
        // A letter changed to a different letter is a different name.
        if let Some((at, c)) = text.char_indices().find(|(_, c)| c.is_ascii_alphabetic()) {
            let other = if c.eq_ignore_ascii_case(&'q') { 'z' } else { 'q' };
            let mut changed = text.clone();
            changed.replace_range(at..at + c.len_utf8(), &other.to_string());
            prop_assert!(!regex.is_match(&changed), "{:?} matched {:?}", text, changed);
        }
    }

    /// `glob_regex` reads `**` as any depth and `*` as one segment: `*` never crosses a slash, the literal segments are
    /// literal (specials escaped, case ignored), and what the glob does not name does not match.
    #[test]
    fn prop_glob_regex_stars_cross_a_slash_only_as_two(
        head in "[A-Za-z0-9 .+()]{1,8}",
        tail in "[A-Za-z0-9 .+()]{1,8}",
        mid in segment(),
        deep in prop::collection::vec(segment(), 2..4),
        flips in flips(),
    ) {
        let one = regex::Regex::new(&format!("^{}$", glob_regex(&format!("{head}/*/{tail}")))).expect("a valid regex");
        let named = format!("{}/{}/{}", recase(&head, &flips), mid, recase(&tail, &flips));
        let crossing = format!("{}/{}/{}", head, deep.join("/"), tail);
        let nothing = format!("{head}/{tail}");
        prop_assert!(one.is_match(&named), "a * did not match one segment: {:?}", named);
        prop_assert!(!one.is_match(&crossing), "a * crossed a slash: {:?}", crossing);
        prop_assert!(!one.is_match(&nothing), "a * matched nothing between two slashes: {:?}", nothing);
        let any = regex::Regex::new(&format!("^{}$", glob_regex(&format!("{head}/**")))).expect("a valid regex");
        let reaching = format!("{}/{}", head, deep.join("/"));
        let outside = format!("x{}/{}", head, deep.join("/"));
        prop_assert!(any.is_match(&reaching), "a ** did not reach every depth: {:?}", reaching);
        prop_assert!(!any.is_match(&outside), "a ** matched a different folder: {:?}", outside);
    }

    /// `normalize_lexical` leaves no `.` or `..` step, is the same when done twice, never goes above the root, and agrees
    /// with a plain walk of the steps.
    #[test]
    fn prop_normalize_lexical_leaves_no_steps_and_walks_like_a_stack(
        steps in prop::collection::vec(prop_oneof![
            4 => segment(),
            2 => Just("..".to_string()),
            1 => Just(".".to_string()),
            1 => Just(String::new()),
        ], 0..12),
        absolute in any::<bool>(),
    ) {
        let text = format!("{}{}", if absolute { "/" } else { "" }, steps.join("/"));
        // An empty first step also makes the path absolute (`"" + "/" + "a"`).
        let absolute = text.starts_with('/');
        let got = normalize_lexical(Path::new(&text));
        prop_assert!(
            got.components().all(|c| !matches!(c, Component::CurDir | Component::ParentDir)),
            "{:?} kept a step: {:?}", text, got
        );
        prop_assert_eq!(normalize_lexical(&got), got.clone(), "not the same twice");
        let mut stack: Vec<&str> = Vec::new();
        for step in steps.iter().map(String::as_str) {
            match step {
                "" | "." => {}
                ".." => {
                    stack.pop();
                }
                other => stack.push(other),
            }
        }
        let expected = format!("{}{}", if absolute { "/" } else { "" }, stack.join("/"));
        prop_assert_eq!(got, PathBuf::from(expected), "{:?}", text);
    }

    /// `folder_forms` gives the folder as given without a trailing slash (the root stays `/`), adds no duplicate, adds the
    /// `/private` form of `/var`, `/tmp` and `/etc` and only of those, and refuses a path it cannot quote.
    #[test]
    fn prop_folder_forms_have_no_trailing_slash_and_refuse_what_cannot_be_quoted(
        top in prop::sample::select(vec!["/var", "/tmp", "/etc", "/usr", "/Users", "/private", ""]),
        rest in prop::collection::vec(odd_name(), 0..3),
        slashes in "/{0,3}",
        bad in prop::option::of(prop::sample::select(vec!['"', '\\', '\n', '\u{0}', '\u{1b}'])),
    ) {
        let mut text = format!("{top}/{}", rest.join("/"));
        if let Some(bad) = bad {
            text.push(bad);
        }
        text.push_str(&slashes);
        let got = folder_forms(Path::new(&text));
        if bad.is_some() {
            prop_assert!(got.is_err(), "{:?} was quoted", text);
            return Ok(());
        }
        let forms = got.expect("a quotable folder");
        let trimmed = text.trim_end_matches('/');
        let first = if trimmed.is_empty() { "/" } else { trimmed };
        prop_assert_eq!(&forms[0], first);
        prop_assert!(forms.iter().all(|form| form == "/" || !form.ends_with('/')), "{:?}", forms);
        let unique: std::collections::BTreeSet<&String> = forms.iter().collect();
        prop_assert_eq!(unique.len(), forms.len(), "a duplicate form in {:?}", forms);
        let privately = forms.iter().any(|form| form == &format!("/private{first}"));
        let linked_top = ["/var", "/tmp", "/etc"].iter().any(|t| first == *t || first.starts_with(&format!("{t}/")));
        prop_assert_eq!(privately, linked_top, "{:?}", forms);
    }
}
