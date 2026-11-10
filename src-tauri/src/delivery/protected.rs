// SPDX-License-Identifier: Apache-2.0
//
// Based on tasklane (https://github.com/kunci115/tasklane)
// crates/tasklane-core/src/paths.rs (`protected_hits`), commit 4a7298e.
// tasklane's LICENSE has no separate copyright line and the repo has no NOTICE file.
//
// Rewritten from the work package rather than copied line for line: the upstream
// file was not in this worktree. Directory patterns still match anywhere, secret
// extensions still match, and a glob still matches nothing. Hivra adds `.hivra/`,
// the hub's tauri config files and the rule files, and compares built-in names
// without case so a renamed secret does not slip past the floor.

//! Protected paths for the merge floor (docs/hivra/work/WP-158-merge-risk-floor.md).
//!
//! Built-in patterns always apply. A project's extra patterns can only add hits.
//! A pattern with `*`, `?` or `[` matches nothing, so a bare `*` cannot match every file.

/// Directory names that are protected wherever they sit in the path.
const DIRECTORIES: &[&str] = &[
    ".github",
    ".circleci",
    ".buildkite",
    ".gitlab",
    "migrations",
    "terraform",
    ".git",
    ".hivra",
];

/// File names protected wherever they sit. Matched whole, not as a prefix.
const FILE_NAMES: &[&str] = &[
    ".gitmodules",
    ".gitattributes",
    "codeowners",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    ".gitlab-ci.yml",
    "azure-pipelines.yml",
    ".travis.yml",
    "appveyor.yml",
    "bitbucket-pipelines.yml",
    "cloudbuild.yml",
    "cloudbuild.yaml",
    "agents.md",
    "claude.md",
    "gemini.md",
    "opencode.json",
    ".envrc",
    // Build and supply-chain inputs: a changed lockfile or manifest can pull in code that runs at build time.
    "cargo.lock",
    "cargo.toml",
    "build.rs",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "rust-toolchain",
    "rust-toolchain.toml",
    ".npmrc",
    ".no-mistakes.yaml",
];

/// File names protected as themselves or with a dotted suffix (`Dockerfile.prod`).
///
/// Agent configuration is held here too: a project's `.claude/` (settings, hooks, agents, commands) and `.mcp.json`
/// load on Ash's Mac when a session starts, so a merge that adds one runs code there.
const DOTTED_NAMES: &[&str] = &[
    "dockerfile",
    "jenkinsfile",
    ".env",
    ".cargo",
    ".claude",
    ".codex",
    ".cursor",
    ".opencode",
    ".gemini",
    ".mcp",
];

/// Secret extensions, including the dot. Matched on the file name, ignoring case.
const SECRET_EXTENSIONS: &[&str] = &[
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".p8",
    ".cer",
    ".crt",
    ".der",
    ".kdbx",
    ".keystore",
    ".jks",
    ".ppk",
    ".tf",
    ".tfvars",
];

/// Key file names protected as themselves or with a dotted suffix (`id_rsa.pub`).
const KEY_NAMES: &[&str] = &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

struct RepoPath {
    display: String,
    lower: Vec<String>,
    suspicious: bool,
}

fn repo_path(raw: &str) -> Option<RepoPath> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    let slashed = trimmed.replace('\\', "/");
    let drive = is_drive(&slashed);
    let absolute = slashed.starts_with('/') || drive;
    let mut suspicious = absolute || slashed.contains('\0');
    let mut lower = Vec::new();
    let mut display_parts = Vec::new();
    for part in slashed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains('\0') {
            suspicious = true;
        }
        let clean: String = part.chars().filter(|c| *c != '\0').collect();
        if clean.is_empty() {
            continue;
        }
        lower.push(clean.to_lowercase());
        display_parts.push(clean);
    }
    if display_parts.is_empty() {
        return None;
    }
    let joined = display_parts.join("/");
    let display = if absolute && !drive {
        format!("/{joined}")
    } else {
        joined
    };
    Some(RepoPath {
        display,
        lower,
        suspicious,
    })
}

/// The file's own extension, including the dot. `.pem` is itself. `photo.tiff` is `.tiff`, not `.tf`.
fn extension_is(segment: &str, ext: &str) -> bool {
    if segment == ext {
        return true;
    }
    match segment.rfind('.') {
        Some(0) | None => false,
        Some(dot) => &segment[dot..] == ext,
    }
}

fn is_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn contains_seq(hay: &[String], needle: &[String]) -> bool {
    if needle.is_empty() || needle.len() > hay.len() {
        return false;
    }
    hay.windows(needle.len()).any(|window| window == needle)
}

fn dotted_hit(segment: &str, name: &str) -> bool {
    segment == name
        || segment
            .strip_prefix(name)
            .is_some_and(|rest| rest.starts_with('.'))
}

fn built_in_hit(path: &RepoPath) -> bool {
    if path.suspicious {
        return true;
    }
    if path.lower.iter().any(|segment| {
        DIRECTORIES.iter().any(|dir| segment == *dir)
            || FILE_NAMES.iter().any(|name| segment == *name)
            || DOTTED_NAMES.iter().any(|name| dotted_hit(segment, name))
            || KEY_NAMES.iter().any(|name| dotted_hit(segment, name))
            || SECRET_EXTENSIONS
                .iter()
                .any(|ext| extension_is(segment, ext))
    }) {
        return true;
    }
    path.lower.windows(2).any(|pair| {
        pair[0] == "src-tauri" && pair[1].starts_with("tauri") && pair[1].ends_with(".json")
    }) || delivery_source(path)
        || capabilities_json(path)
        || tauri_build_inputs(path)
        || rust_roots(path)
}

/// `src-tauri/capabilities/*.json` and `*.toml`, including a nested app. The directory is the prefix.
fn capabilities_json(path: &RepoPath) -> bool {
    match path.lower.last() {
        Some(file) if extension_is(file, ".json") || extension_is(file, ".toml") => path
            .lower
            .windows(2)
            .any(|pair| pair[0] == "src-tauri" && pair[1] == "capabilities"),
        _ => false,
    }
}

/// The crate roots and the GitHub reader. A `#[path]` on a crate root can point `mod delivery` at other code, which
/// would bypass the literal `delivery/` match, and the reader decides what the floor is told about a pull request.
/// Merged Rust is a full compromise anyway: the floor is not the control for it. Holding these is a speed bump.
fn rust_roots(path: &RepoPath) -> bool {
    path.lower.windows(3).any(|window| {
        window[0] == "src-tauri" && window[1] == "src" && (window[2] == "lib.rs" || window[2] == "main.rs")
    }) || path.lower.windows(4).any(|window| {
        window[0] == "src-tauri"
            && window[1] == "src"
            && window[2] == "pr_watch"
            && window[3] == "github.rs"
    })
}

/// Tauri's own build and permission inputs: any `*.plist` directly in `src-tauri/`, and anything under
/// `src-tauri/permissions/`. These decide what the app may do when it is built and run.
fn tauri_build_inputs(path: &RepoPath) -> bool {
    path.lower.windows(2).any(|pair| {
        pair[0] == "src-tauri" && (pair[1].ends_with(".plist") || pair[1] == "permissions")
    })
}

/// The floor's own source. A merge that can edit this directory can delete the floor.
fn delivery_source(path: &RepoPath) -> bool {
    path.lower
        .windows(3)
        .any(|window| window[0] == "src-tauri" && window[1] == "src" && window[2] == "delivery")
}

struct Extra {
    parts: Vec<String>,
    directory: bool,
}

fn extra_rule(raw: &str) -> Option<Extra> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains(['*', '?', '[']) {
        return None;
    }
    let directory = trimmed.ends_with('/') || trimmed.ends_with('\\');
    let path = repo_path(trimmed)?;
    if path.suspicious {
        return None;
    }
    Some(Extra {
        parts: path.lower,
        directory,
    })
}

fn extra_hit(path: &RepoPath, extra: &Extra) -> bool {
    if path.suspicious {
        return false;
    }
    if extra.directory || extra.parts.len() > 1 {
        return contains_seq(&path.lower, &extra.parts);
    }
    path.lower.iter().any(|segment| segment == &extra.parts[0])
}

/// What `gh` said the pull request changes. `Unread` is a failure to read, including a
/// timeout, or a list that is not the whole diff. The floor asks, and a later try can read again.
/// `reason` is the reader's own words, kept so the ask says why.
pub enum ChangedFiles {
    Listed(Vec<String>),
    Unread { reason: String },
}

/// A parsed file list, before it is compared with GitHub's changed-file count.
/// `filenames` counts current names only. A rename's old name is in `paths` and is not counted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileList {
    pub paths: Vec<String>,
    pub filenames: usize,
}

/// The raw read. A parsed body is not yet the whole diff: [`judge`] decides that.
pub enum ReadFiles {
    Parsed(FileList),
    Unread { reason: String },
}

/// GitHub's compare endpoint lists at most this many files, and still exits 0. A list of this many may be short.
const FILE_LIST_CEILING: usize = 300;

/// The list is the whole diff only when the number of current filenames equals `reported`
/// (`changedFiles` on the pull request) and is under the API ceiling. An empty list is the
/// whole diff only when `reported` is 0. Anything else is unread, including a missing count.
pub fn judge(read: ReadFiles, reported: Option<u64>) -> ChangedFiles {
    let list = match read {
        ReadFiles::Unread { reason } => return ChangedFiles::Unread { reason },
        ReadFiles::Parsed(list) => list,
    };
    if list.filenames >= FILE_LIST_CEILING {
        return ChangedFiles::Unread {
            reason: format!(
                "GitHub's file list stops at {FILE_LIST_CEILING} files, so this one may be short."
            ),
        };
    }
    match reported {
        Some(count) if count == list.filenames as u64 => ChangedFiles::Listed(list.paths),
        Some(count) => ChangedFiles::Unread {
            reason: format!(
                "GitHub says this pull request changes {count} files, but the list has {}.",
                list.filenames
            ),
        },
        None => ChangedFiles::Unread {
            reason: "GitHub didn't say how many files this pull request changes.".into(),
        },
    }
}

/// Current filename, then the old name of a rename. The old name is marked so it is not
/// counted as another file. A bare line is a current filename (tests, and a list with no renames).
const FILE_LIST_JQ: &str = r#".files[] | "filename:\(.filename)", (select(.previous_filename != null) | "previous:\(.previous_filename)")"#;

/// Whether `text` is a full commit id (40 hex digits). Only then is it put in a request path.
fn is_commit(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The changed paths between two commits, renames included (the old name and the new one), read as
/// `base...head`. This is the diff of the commits the merge judged, not of whatever the pull request says now:
/// a head or base that moves can't change what was listed. Goes through `Github::run`, the existing `gh` reader
/// and its allow-listed child environment. A base or head that is not a commit id is not listed. A list that
/// cannot be read, or that is not a list of paths, is [`ReadFiles::Unread`] and keeps the reader's error.
pub fn changed_files_between(
    gh: &dyn super::github::Github,
    repo: &str,
    base: &str,
    head: &str,
) -> ReadFiles {
    if crate::pr_watch::github::split_repo(repo).is_none() || !is_commit(base) || !is_commit(head) {
        return ReadFiles::Unread {
            reason: "the repository or the commits to compare are not ones GitHub can list".into(),
        };
    }
    let repo = repo.trim();
    let args = [
        "api".to_string(),
        format!("repos/{repo}/compare/{base}...{head}"),
        "--jq".to_string(),
        FILE_LIST_JQ.to_string(),
    ];
    match gh.run(None, &args) {
        Ok(body) => match parse_file_list(&body) {
            Ok(list) => ReadFiles::Parsed(list),
            Err(()) => ReadFiles::Unread {
                reason: "the file list was not a list of paths".into(),
            },
        },
        Err(error) => ReadFiles::Unread { reason: error },
    }
}

/// One path per line, as `gh api --jq` prints them. `null` and blanks are skipped.
/// JSON, a NUL, or a control character means the body is not a path list.
/// `filename:` lines count toward the changed-file total. `previous:` lines are old names
/// of a rename: they are held, and they are not counted.
pub(crate) fn parse_file_list(body: &str) -> Result<FileList, ()> {
    let trimmed = body.trim();
    if (trimmed.starts_with('{') || trimmed.starts_with('[')) && trimmed.contains(['"', ':']) {
        return Err(());
    }
    if body.contains('\0') {
        return Err(());
    }
    let mut paths = Vec::new();
    let mut filenames = 0usize;
    let mut current = std::collections::HashSet::new();
    for line in body.split(['\n', '\r']) {
        let line = line.trim();
        if line.is_empty() || line == "null" {
            continue;
        }
        if line.chars().any(char::is_control) {
            return Err(());
        }
        let (path, is_filename) = marked_path(line);
        if path.is_empty() {
            continue;
        }
        if is_filename {
            // A name listed twice would count as two files. The list is not the whole diff, so it is unread.
            if !current.insert(path.clone()) {
                return Err(());
            }
            filenames += 1;
        }
        if paths.iter().any(|seen: &String| seen == &path) {
            continue;
        }
        paths.push(path);
    }
    Ok(FileList { paths, filenames })
}

/// `filename:` is the current name. `previous:` is the old name of a rename.
/// Anything else is a current name, so a list with no renames stays a list of paths.
fn marked_path(line: &str) -> (String, bool) {
    if let Some(path) = line.strip_prefix("filename:") {
        (path.to_string(), true)
    } else if let Some(path) = line.strip_prefix("previous:") {
        (path.to_string(), false)
    } else {
        (line.to_string(), true)
    }
}

/// Paths from `paths` that the floor holds. Built-ins always count. `extras` only add.
/// Each path is returned once, in input order, with `\` turned into `/` and `.` segments
/// dropped. A `..` segment is not folded out: the path is untrusted, so it counts as a hit.
pub fn protected_hits<P: AsRef<str>, E: AsRef<str>>(paths: &[P], extras: &[E]) -> Vec<String> {
    let extras: Vec<Extra> = extras
        .iter()
        .filter_map(|extra| extra_rule(extra.as_ref()))
        .collect();
    let mut hits = Vec::new();
    for path in paths {
        let Some(parsed) = repo_path(path.as_ref()) else {
            continue;
        };
        if hits.iter().any(|seen: &String| seen == &parsed.display) {
            continue;
        }
        if built_in_hit(&parsed) || extras.iter().any(|extra| extra_hit(&parsed, extra)) {
            hits.push(parsed.display);
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits(paths: &[&str], extras: &[&str]) -> Vec<String> {
        protected_hits(paths, extras)
    }

    #[test]
    fn built_in_directories_match_anywhere() {
        for dir in DIRECTORIES {
            let nested = format!("pkg/{dir}/file");
            let rooted = format!("{dir}/file");
            assert_eq!(hits(&[&nested], &[]), vec![nested], "{dir}");
            assert_eq!(hits(&[&rooted], &[]), vec![rooted], "{dir}");
        }
        assert!(hits(&["notmigrations/a.sql"], &[]).is_empty());
        assert!(hits(&["src/.gitignore"], &[]).is_empty());
        assert_eq!(hits(&[".git/config"], &[]), vec![".git/config".to_string()]);
    }

    #[test]
    fn ci_compose_keys_env_and_hub_config_hit_and_ordinary_files_do_not() {
        let protected = [
            ".github/workflows/x.yml",
            "CODEOWNERS",
            "docs/CODEOWNERS",
            ".gitmodules",
            ".gitattributes",
            "Dockerfile",
            "app/Dockerfile.prod",
            "docker-compose.yml",
            "compose.yaml",
            "Jenkinsfile",
            "ci/Jenkinsfile.nightly",
            ".gitlab-ci.yml",
            "azure-pipelines.yml",
            ".travis.yml",
            "appveyor.yml",
            "bitbucket-pipelines.yml",
            "cloudbuild.yaml",
            ".circleci/config.yml",
            ".env",
            ".env.local",
            "config/.env.production",
            ".ENV",
            "keys/server.pem",
            "keys/server.PEM",
            "id_ed25519",
            "id_rsa.pub",
            "infra/main.tf",
            "infra/prod.tfvars",
            ".hivra/rules.md",
            "AGENTS.md",
            "nested/CLAUDE.md",
            "src-tauri/tauri.conf.json",
            "src-tauri/tauri.hub.conf.json",
            "src-tauri/tauri.linux.conf.json",
            "apps/desktop/src-tauri/tauri.windows.conf.json",
            ".envrc",
            "config/.envrc",
            ".ENVRC",
            "src-tauri/capabilities/main.json",
            "apps/desktop/src-tauri/capabilities/desktop.json",
            "src-tauri/capabilities/nested/extra.json",
        ];
        for path in protected {
            assert_eq!(hits(&[path], &[]), vec![path.to_string()], "{path}");
        }
        for path in [
            "readme.md",
            "src/environment.ts",
            "src/envelope.rs",
            "src/.gitignore",
            "notes/poem.txt",
            "photo.tiff",
            ".environment",
            "id_rsa_backup",
            // Beside the floor's own module, which is held. This file is not.
            "src-tauri/src/pr_watch/mod.rs",
            "not.github/workflows/x.yml",
            "mydockerfile",
            "src-tauri/capabilities/readme.md",
            "src-tauri/capabilities.json",
            "other/capabilities/main.json",
        ] {
            assert!(hits(&[path], &[]).is_empty(), "{path}");
        }
    }

    #[test]
    fn the_floor_holds_its_own_source_and_not_an_ordinary_file_beside_it() {
        for path in [
            "src-tauri/src/delivery/merge.rs",
            "src-tauri/src/delivery/protected.rs",
            "src-tauri/src/delivery/settings.rs",
            "src-tauri/src/delivery/mod.rs",
            "src-tauri/src/delivery/deliver.rs",
            "src-tauri/src/delivery/events.rs",
            "src-tauri/src/delivery/github.rs",
            "src-tauri/src/delivery/teardown.rs",
            "src-tauri/src/delivery/tests.rs",
            "apps/desktop/src-tauri/src/delivery/merge.rs",
        ] {
            assert_eq!(hits(&[path], &[]), vec![path.to_string()], "{path}");
        }
        assert!(
            hits(&["src-tauri/src/pr_watch/mod.rs"], &[]).is_empty(),
            "an ordinary file beside the floor is not held"
        );
        assert!(hits(&["src/delivery/merge.rs"], &[]).is_empty());
    }

    #[test]
    fn extras_only_add_and_a_glob_matches_nothing() {
        assert_eq!(
            hits(&["docs/runbook.md"], &["docs/runbook.md"]),
            vec!["docs/runbook.md".to_string()]
        );
        assert!(hits(&["docs/other.md"], &["docs/runbook.md"]).is_empty());
        assert_eq!(
            hits(&["vendor/secrets/key.txt"], &["vendor/secrets/"]),
            vec!["vendor/secrets/key.txt".to_string()]
        );
        // A single extra name matches that file anywhere. It does not drop a built-in.
        assert_eq!(
            hits(
                &["readme.md", ".github/workflows/x.yml"],
                &["*", "?", "[a]", "**", "secret*"]
            ),
            vec![".github/workflows/x.yml".to_string()]
        );
        assert!(hits(&["readme.md"], &["*"]).is_empty());
        assert!(hits(&["readme.md"], &[""]).is_empty());
        assert!(hits(&["readme.md"], &["   "]).is_empty());
        assert!(hits(&["readme.md"], &["../secrets"]).is_empty());
        assert_eq!(
            hits(&["My File.yml"], &["my file.yml"]),
            vec!["My File.yml".to_string()]
        );
    }

    #[test]
    fn odd_paths_hit_and_blanks_and_duplicates_do_not_multiply() {
        assert_eq!(
            hits(&["migrations\\001.sql"], &[]),
            vec!["migrations/001.sql".to_string()]
        );
        assert_eq!(
            hits(&["pkg/./migrations/donnée.sql"], &[]),
            vec!["pkg/migrations/donnée.sql".to_string()]
        );
        assert_eq!(
            hits(&[".github/workflows/my file.yml"], &[]),
            vec![".github/workflows/my file.yml".to_string()]
        );
        assert_eq!(hits(&["src/../.env"], &[]), vec!["src/../.env".to_string()]);
        assert_eq!(
            hits(&["docs/../readme.md"], &[]),
            vec!["docs/../readme.md".to_string()]
        );
        assert_eq!(hits(&["/etc/passwd"], &[]), vec!["/etc/passwd".to_string()]);
        assert_eq!(
            hits(&["C:/secret.key"], &[]),
            vec!["C:/secret.key".to_string()]
        );
        assert_eq!(
            hits(
                &[".github/workflows/x.yml", ".github/workflows/x.yml", ""],
                &[]
            ),
            vec![".github/workflows/x.yml".to_string()]
        );
        assert!(hits(&[""], &[]).is_empty());
        assert!(hits(&["./"], &[]).is_empty());
    }

    fn listed(body: &str) -> Result<Vec<String>, ()> {
        parse_file_list(body).map(|list| list.paths)
    }

    #[test]
    fn a_changed_file_list_keeps_both_names_of_a_rename_and_rejects_a_body_that_is_not_paths() {
        assert_eq!(
            listed(".github/workflows/old.yml\nsrc/new name.yml\n").unwrap(),
            vec![
                ".github/workflows/old.yml".to_string(),
                "src/new name.yml".to_string()
            ]
        );
        assert_eq!(
            listed("src/a.rs\r\nnull\r\n\r\n").unwrap(),
            vec!["src/a.rs".to_string()]
        );
        assert_eq!(
            listed("migrations\\001.sql\n").unwrap(),
            vec!["migrations\\001.sql".to_string()]
        );
        assert!(listed("").unwrap().is_empty());
        assert!(listed("{\"filename\":\"a\"}\n").is_err());
        assert!(listed("[{\"filename\":\"a\"}]\n").is_err());
        assert!(listed("src/a.rs\0hidden/.env\n").is_err());
        // A one-line name that merely starts with a brace is still a path.
        assert_eq!(listed("{notes}\n").unwrap(), vec!["{notes}".to_string()]);
    }

    #[test]
    fn an_unreadable_changed_file_list_is_not_an_empty_diff() {
        use super::super::github::fake::FakeGithub;

        let base = "ba5e".repeat(10);
        let head = "1ead".repeat(10);
        let gh = FakeGithub::new(vec![]);
        *gh.files.lock().unwrap() = Some(Ok(".github/workflows/old.yml\nsrc/renamed.yml\n".into()));
        match changed_files_between(&gh, "acme/web", &base, &head) {
            ReadFiles::Parsed(list) => assert_eq!(
                list.paths,
                vec![
                    ".github/workflows/old.yml".to_string(),
                    "src/renamed.yml".to_string()
                ]
            ),
            ReadFiles::Unread { reason } => panic!("the list was readable: {reason}"),
        }
        let call = gh.ran("api", &format!("repos/acme/web/compare/{base}...{head}"));
        assert_eq!(call.len(), 1);
        let jq = call[0]
            .iter()
            .find(|arg| arg.contains(".filename"))
            .expect("jq");
        assert!(jq.contains(".previous_filename"), "{jq}");
        assert!(jq.contains("filename:"), "{jq}");
        assert!(jq.contains("previous:"), "{jq}");
        assert!(
            call[0]
                .iter()
                .all(|arg| !arg.contains("ghp_") && !arg.contains("token")),
            "the file list request must not carry a token: {call:?}"
        );

        // A timeout or any other failure is unread, and the reader's words are kept.
        *gh.files.lock().unwrap() = Some(Err("gh didn't answer within 2 minutes".into()));
        match changed_files_between(&gh, "acme/web", &base, &head) {
            ReadFiles::Unread { reason } => assert!(reason.contains("2 minutes"), "{reason}"),
            ReadFiles::Parsed(_) => panic!("a timeout is not a file list"),
        }
        *gh.files.lock().unwrap() = Some(Ok("{\"message\":\"bad\"}\n".into()));
        match changed_files_between(&gh, "acme/web", &base, &head) {
            ReadFiles::Unread { reason } => {
                assert!(reason.contains("not a list of paths"), "{reason}")
            }
            ReadFiles::Parsed(_) => panic!("json is not a file list"),
        }

        // An empty success parses as no files. It is the whole diff only when the count is 0.
        *gh.files.lock().unwrap() = Some(Ok(String::new()));
        match changed_files_between(&gh, "acme/web", &base, &head) {
            ReadFiles::Parsed(list) => {
                assert!(list.paths.is_empty());
                assert_eq!(list.filenames, 0);
            }
            ReadFiles::Unread { reason } => panic!("an empty body is a list of nothing: {reason}"),
        }

        let runs_before = gh.runs.lock().unwrap().len();
        assert!(matches!(
            changed_files_between(&gh, "../not a repo", &base, &head),
            ReadFiles::Unread { .. }
        ));
        assert!(matches!(
            changed_files_between(&gh, "acme/web", "main", &head),
            ReadFiles::Unread { .. }
        ));
        assert_eq!(
            gh.runs.lock().unwrap().len(),
            runs_before,
            "a bad repo or number never calls gh"
        );
    }

    fn page_of(filenames: usize) -> String {
        (0..filenames)
            .map(|i| format!("filename:src/f{i}.rs\n"))
            .collect()
    }

    #[test]
    fn a_short_or_capped_file_list_is_not_the_whole_diff() {
        // Page one of a two-page diff (GitHub's default page is 30). The count says there is more.
        let page_one = parse_file_list(&page_of(30)).unwrap();
        assert_eq!(page_one.filenames, 30);
        match judge(ReadFiles::Parsed(page_one), Some(60)) {
            ChangedFiles::Unread { reason } => {
                assert!(reason.contains("60"), "{reason}");
                assert!(reason.contains("30"), "{reason}");
            }
            ChangedFiles::Listed(_) => panic!("page one is not the whole diff"),
        }

        let two = parse_file_list("filename:src/a.rs\nfilename:src/b.rs\n").unwrap();
        assert!(matches!(
            judge(ReadFiles::Parsed(two), Some(5)),
            ChangedFiles::Unread { .. }
        ));

        // The compare endpoint stops at 300 and still returns success. A matching count of 300 is not the whole diff.
        let capped = parse_file_list(&page_of(300)).unwrap();
        assert!(matches!(
            judge(ReadFiles::Parsed(capped), Some(300)),
            ChangedFiles::Unread { reason } if reason.contains("300")
        ));
        let over = parse_file_list(&page_of(301)).unwrap();
        assert!(matches!(
            judge(ReadFiles::Parsed(over), Some(301)),
            ChangedFiles::Unread { .. }
        ));

        // Just under the ceiling, a matching count is the whole diff.
        let under = parse_file_list(&page_of(299)).unwrap();
        assert!(matches!(
            judge(ReadFiles::Parsed(under), Some(299)),
            ChangedFiles::Listed(paths) if paths.len() == 299
        ));

        // A missing count is unread, even when the body parsed.
        let one = parse_file_list("filename:readme.md\n").unwrap();
        assert!(matches!(
            judge(ReadFiles::Parsed(one), None),
            ChangedFiles::Unread { reason } if reason.contains("didn't say")
        ));

        // An empty list allows only when GitHub says nothing changed.
        let empty = parse_file_list("").unwrap();
        assert!(matches!(
            judge(ReadFiles::Parsed(empty.clone()), Some(0)),
            ChangedFiles::Listed(paths) if paths.is_empty()
        ));
        match judge(ReadFiles::Parsed(empty), Some(5)) {
            ChangedFiles::Unread { reason } => assert!(reason.contains('5'), "{reason}"),
            ChangedFiles::Listed(_) => panic!("an empty list is not five files"),
        }

        // The reader's error is kept, and a count is not consulted.
        match judge(
            ReadFiles::Unread {
                reason: "gh didn't answer within 2 minutes".into(),
            },
            Some(0),
        ) {
            ChangedFiles::Unread { reason } => assert!(reason.contains("2 minutes"), "{reason}"),
            ChangedFiles::Listed(_) => panic!("a timeout is not an empty diff"),
        }
    }

    #[test]
    fn a_rename_counts_the_current_name_and_keeps_the_old_one() {
        let body = "filename:src/new name.rs\nprevious:.github/workflows/old.yml\n";
        let list = parse_file_list(body).unwrap();
        assert_eq!(list.filenames, 1, "previous_filename is not another file");
        assert_eq!(
            list.paths,
            vec![
                "src/new name.rs".to_string(),
                ".github/workflows/old.yml".to_string()
            ]
        );
        match judge(ReadFiles::Parsed(list), Some(1)) {
            ChangedFiles::Listed(paths) => {
                assert_eq!(
                    protected_hits(&paths, &[] as &[&str]),
                    vec![".github/workflows/old.yml".to_string()]
                );
            }
            ChangedFiles::Unread { reason } => {
                panic!("a complete rename is the whole diff: {reason}")
            }
        }

        // Old names do not trip the 300 ceiling, and they do not inflate the count.
        let mut many = String::from("filename:src/new.rs\n");
        for i in 0..2999 {
            many.push_str(&format!("previous:src/old{i}.rs\n"));
        }
        let list = parse_file_list(&many).unwrap();
        assert_eq!(list.filenames, 1);
        assert!(matches!(
            judge(ReadFiles::Parsed(list), Some(1)),
            ChangedFiles::Listed(_)
        ));
    }

    #[test]
    fn agent_configuration_is_held_wherever_it_sits() {
        // Project settings, hooks and MCP servers load from these, so a merge that adds one runs code on Ash's Mac.
        for path in [
            ".claude/settings.json",
            ".claude/settings.local.json",
            ".claude/agents/reviewer.md",
            ".claude/commands/ship.md",
            "nested/app/.claude/settings.json",
            ".claude.json",
            ".mcp.json",
            "tools/.mcp.json",
            ".codex/config.toml",
            ".cursor/rules/rules.mdc",
            ".opencode/config.json",
            ".gemini/settings.json",
            "opencode.json",
            "GEMINI.md",
            "docs/GEMINI.md",
            "CLAUDE.md",
        ] {
            assert_eq!(hits(&[path], &[]), vec![path.to_string()], "{path}");
        }
        assert!(hits(&["docs/claude-notes.md"], &[]).is_empty());
        assert!(hits(&["src/codex.ts"], &[]).is_empty());
    }

    #[test]
    fn build_and_supply_chain_files_are_held() {
        for path in [
            "Cargo.lock",
            "src-tauri/Cargo.lock",
            "Cargo.toml",
            "src-tauri/Cargo.toml",
            "package.json",
            "packages/ui/package.json",
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "bun.lock",
            "bun.lockb",
            "npm-shrinkwrap.json",
            "src-tauri/build.rs",
            ".cargo/config.toml",
            "rust-toolchain.toml",
            "rust-toolchain",
            ".npmrc",
            "src-tauri/Entitlements.plist",
            "src-tauri/Info.plist",
            "src-tauri/capabilities/default.toml",
            "src-tauri/permissions/app.toml",
            ".no-mistakes.yaml",
        ] {
            assert_eq!(hits(&[path], &[]), vec![path.to_string()], "{path}");
        }
        for path in ["src/package.jsonish.ts", "docs/build.rs.md", "src/lockfile.ts"] {
            assert!(hits(&[path], &[]).is_empty(), "{path}");
        }
    }

    #[test]
    fn the_rust_roots_and_the_github_reader_are_held() {
        // A `#[path]` on the crate root can point `mod delivery` anywhere, so the roots are held with the floor.
        for path in [
            "src-tauri/src/lib.rs",
            "src-tauri/src/main.rs",
            "src-tauri/src/pr_watch/github.rs",
            "apps/desktop/src-tauri/src/lib.rs",
        ] {
            assert_eq!(hits(&[path], &[]), vec![path.to_string()], "{path}");
        }
    }

    #[test]
    fn a_name_listed_twice_is_not_a_clean_file_list() {
        assert!(parse_file_list("filename:src/a.rs\nfilename:src/a.rs\n").is_err());
        assert!(parse_file_list("src/a.rs\nsrc/a.rs\n").is_err());
        // An old name may repeat: it is not a second file.
        assert!(parse_file_list("filename:src/new.rs\nprevious:src/old.rs\nprevious:src/old.rs\n").is_ok());
    }
}
