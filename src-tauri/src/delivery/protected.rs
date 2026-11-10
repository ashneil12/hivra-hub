// SPDX-License-Identifier: Apache-2.0
//
// Translated from tasklane (https://github.com/kunci115/tasklane)
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
//!
//! The matcher is unused by the merge path until that path consults it. The allow
//! goes away in that change.

#![allow(dead_code)]

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
];

/// File names protected as themselves or with a dotted suffix (`Dockerfile.prod`).
const DOTTED_NAMES: &[&str] = &["dockerfile", "jenkinsfile", ".env"];

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
    })
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
/// timeout: the floor treats that as protected, and a later try can read the list again.
pub enum ChangedFiles {
    Listed(Vec<String>),
    Unread,
}

/// The pull request's changed paths, renames included (the old name and the new one).
/// Goes through `Github::run`, which is the existing `gh` reader and its allow-listed
/// child environment. A list that cannot be read, or that is not a list of paths, is
/// [`ChangedFiles::Unread`].
pub fn changed_files(gh: &dyn super::github::Github, repo: &str, number: u64) -> ChangedFiles {
    if number == 0 || crate::pr_watch::github::split_repo(repo).is_none() {
        return ChangedFiles::Unread;
    }
    let repo = repo.trim();
    let args = [
        "api".to_string(),
        "--paginate".to_string(),
        format!("repos/{repo}/pulls/{number}/files"),
        "--jq".to_string(),
        ".[] | .filename, (.previous_filename // empty)".to_string(),
    ];
    match gh.run(None, &args) {
        Ok(body) => match parse_changed_files(&body) {
            Ok(paths) => ChangedFiles::Listed(paths),
            Err(()) => ChangedFiles::Unread,
        },
        Err(_) => ChangedFiles::Unread,
    }
}

/// One path per line, as `gh api --jq` prints them. `null` and blanks are skipped.
/// JSON, a NUL, or a control character means the body is not a path list.
pub(crate) fn parse_changed_files(body: &str) -> Result<Vec<String>, ()> {
    let trimmed = body.trim();
    if (trimmed.starts_with('{') || trimmed.starts_with('[')) && trimmed.contains(['"', ':']) {
        return Err(());
    }
    if body.contains('\0') {
        return Err(());
    }
    let mut paths = Vec::new();
    for line in body.split(['\n', '\r']) {
        let line = line.trim();
        if line.is_empty() || line == "null" {
            continue;
        }
        if line.chars().any(char::is_control) {
            return Err(());
        }
        if paths.iter().any(|seen: &String| seen == line) {
            continue;
        }
        paths.push(line.to_string());
    }
    Ok(paths)
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
            "src-tauri/src/lib.rs",
            "src-tauri/Cargo.toml",
            "not.github/workflows/x.yml",
            "mydockerfile",
        ] {
            assert!(hits(&[path], &[]).is_empty(), "{path}");
        }
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

    #[test]
    fn a_changed_file_list_keeps_both_names_of_a_rename_and_rejects_a_body_that_is_not_paths() {
        assert_eq!(
            parse_changed_files(".github/workflows/old.yml\nsrc/new name.yml\n").unwrap(),
            vec![
                ".github/workflows/old.yml".to_string(),
                "src/new name.yml".to_string()
            ]
        );
        assert_eq!(
            parse_changed_files("src/a.rs\r\nsrc/a.rs\r\nnull\r\n\r\n").unwrap(),
            vec!["src/a.rs".to_string()]
        );
        assert_eq!(
            parse_changed_files("migrations\\001.sql\n").unwrap(),
            vec!["migrations\\001.sql".to_string()]
        );
        assert!(parse_changed_files("").unwrap().is_empty());
        assert!(parse_changed_files("{\"filename\":\"a\"}\n").is_err());
        assert!(parse_changed_files("[{\"filename\":\"a\"}]\n").is_err());
        assert!(parse_changed_files("src/a.rs\0hidden/.env\n").is_err());
        // A one-line name that merely starts with a brace is still a path.
        assert_eq!(
            parse_changed_files("{notes}\n").unwrap(),
            vec!["{notes}".to_string()]
        );
    }

    #[test]
    fn an_unreadable_changed_file_list_is_not_an_empty_diff() {
        use super::super::github::fake::FakeGithub;
        use super::ChangedFiles;

        let gh = FakeGithub::new(vec![]);
        *gh.files.lock().unwrap() = Some(Ok(".github/workflows/old.yml\nsrc/renamed.yml\n".into()));
        match changed_files(&gh, "acme/web", 7) {
            ChangedFiles::Listed(paths) => assert_eq!(
                paths,
                vec![
                    ".github/workflows/old.yml".to_string(),
                    "src/renamed.yml".to_string()
                ]
            ),
            ChangedFiles::Unread => panic!("the list was readable"),
        }
        let call = gh.ran("api", "--paginate");
        assert_eq!(call.len(), 1);
        assert_eq!(call[0][2], "repos/acme/web/pulls/7/files");
        assert!(call[0].contains(&"--jq".to_string()));
        assert!(
            call[0]
                .iter()
                .all(|arg| !arg.contains("ghp_") && !arg.contains("token")),
            "the file list request must not carry a token: {call:?}"
        );

        // A timeout or any other failure is unread, and the error text is dropped.
        *gh.files.lock().unwrap() = Some(Err("gh didn't answer within 2 minutes".into()));
        assert!(matches!(
            changed_files(&gh, "acme/web", 7),
            ChangedFiles::Unread
        ));
        *gh.files.lock().unwrap() = Some(Ok("{\"message\":\"bad\"}\n".into()));
        assert!(matches!(
            changed_files(&gh, "acme/web", 7),
            ChangedFiles::Unread
        ));

        // An empty success is an empty diff, not a failure.
        *gh.files.lock().unwrap() = Some(Ok(String::new()));
        assert!(matches!(
            changed_files(&gh, "acme/web", 7),
            ChangedFiles::Listed(paths) if paths.is_empty()
        ));

        let runs_before = gh.runs.lock().unwrap().len();
        assert!(matches!(
            changed_files(&gh, "../not a repo", 7),
            ChangedFiles::Unread
        ));
        assert!(matches!(
            changed_files(&gh, "acme/web", 0),
            ChangedFiles::Unread
        ));
        assert_eq!(
            gh.runs.lock().unwrap().len(),
            runs_before,
            "a bad repo or number never calls gh"
        );
    }
}
