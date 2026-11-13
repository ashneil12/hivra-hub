//! SC-6 (spec 4i): property tests for the commit guard.
//!
//! The rule that must always hold: no push or commit the guard passes carries a secret, in any commit, and an agent-only
//! file never passes, in any spelling the guard folds. Two layers:
//!
//! - the patch layer drives `check_patch` over multi-commit unified diffs whose added lines hold every secret shape in
//!   `secretPatterns.json` at random offsets inside random text (CRLF, UTF-16 NULs, unicode), and `agent_file_kind` over
//!   every spelling the path fold promises;
//! - the git layer builds real repositories and runs `gate_range` over the commits a push would carry, so what git
//!   really stores (binary-marked files, attributes, a merge, a later commit that removes the secret) is what is read.

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

use proptest::prelude::*;
use proptest::sample::Index;
use proptest::strategy::Union;

use super::*;

/// 64 cases a run, or whatever `PROPTEST_CASES` says (an explicit `cases` would override the variable).
fn config() -> ProptestConfig {
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 64;
    }
    config
}

// ---- secrets, as the scrubber's patterns write them -----------------------------------------------------------------

/// One secret in each shape `secretPatterns.json` lists (built here, so no source file holds a real secret).
fn secret() -> impl Strategy<Value = String> {
    let shapes: Vec<BoxedStrategy<String>> = vec![
        // Anthropic key.
        "[A-Za-z0-9_-]{20,40}"
            .prop_map(|body| format!("sk-ant-{body}"))
            .boxed(),
        // API key (sk-), with and without a vendor prefix.
        (
            prop::sample::select(vec!["", "proj-", "svcacct-", "or-v1-", "live-"]),
            "[A-Za-z0-9_-]{32,48}",
        )
            .prop_map(|(prefix, body)| format!("sk-{prefix}{body}"))
            .boxed(),
        // GitHub tokens.
        (
            prop::sample::select(vec!["ghp", "gho", "ghu", "ghs", "ghr"]),
            "[A-Za-z0-9]{30,50}",
        )
            .prop_map(|(kind, body)| format!("{kind}_{body}"))
            .boxed(),
        "[A-Za-z0-9_]{40,60}"
            .prop_map(|body| format!("github_pat_{body}"))
            .boxed(),
        // GitLab token.
        (
            prop::sample::select(vec!["glpat", "gldt", "glrt", "glrtr"]),
            "[A-Za-z0-9_-]{20,40}",
        )
            .prop_map(|(kind, body)| format!("{kind}-{body}"))
            .boxed(),
        // PyPI token.
        "[A-Za-z0-9_-]{40,60}"
            .prop_map(|body| format!("pypi-AgE{body}"))
            .boxed(),
        // SendGrid key.
        ("[A-Za-z0-9_-]{22}", "[A-Za-z0-9_-]{43}")
            .prop_map(|(a, b)| format!("SG.{a}.{b}"))
            .boxed(),
        // Slack tokens.
        (
            prop::sample::select(vec!['a', 'b', 'p', 'o', 's', 'r']),
            "[A-Za-z0-9-]{10,30}",
        )
            .prop_map(|(kind, body)| format!("xox{kind}-{body}"))
            .boxed(),
        "[A-Za-z0-9-]{20,40}"
            .prop_map(|body| format!("xapp-{body}"))
            .boxed(),
        // Stripe webhook secret and keys.
        "[A-Za-z0-9_-]{20,40}"
            .prop_map(|body| format!("whsec_{body}"))
            .boxed(),
        (
            prop::sample::select(vec!["sk", "rk"]),
            prop::sample::select(vec!["live", "test"]),
            "[0-9A-Za-z]{16,40}",
        )
            .prop_map(|(kind, mode, body)| format!("{kind}_{mode}_{body}"))
            .boxed(),
        // AWS access key (it ends on a word boundary).
        (prop::sample::select(vec!["AKIA", "ASIA"]), "[0-9A-Z]{16}")
            .prop_map(|(kind, body)| format!("{kind}{body}"))
            .boxed(),
        // Google API key.
        "[0-9A-Za-z_-]{35}"
            .prop_map(|body| format!("AIza{body}"))
            .boxed(),
        // JSON web token.
        (
            "[A-Za-z0-9_-]{10,30}",
            "[A-Za-z0-9_-]{10,30}",
            "[A-Za-z0-9_-]{10,30}",
        )
            .prop_map(|(a, b, c)| format!("eyJ{a}.eyJ{b}.{c}"))
            .boxed(),
        // Supabase, xAI, Resend, npm and Hugging Face tokens.
        "[A-Za-z0-9]{30,50}"
            .prop_map(|body| format!("sbp_{body}"))
            .boxed(),
        "[A-Za-z0-9]{40,60}"
            .prop_map(|body| format!("xai-{body}"))
            .boxed(),
        ("[A-Za-z0-9]{8,20}", "[A-Za-z0-9]{16,30}")
            .prop_map(|(a, b)| format!("re_{a}_{b}"))
            .boxed(),
        "[A-Za-z0-9]{36}"
            .prop_map(|body| format!("npm_{body}"))
            .boxed(),
        "[A-Za-z0-9]{30,50}"
            .prop_map(|body| format!("hf_{body}"))
            .boxed(),
        // Bearer token: its value must hold a letter and a digit.
        (
            prop::sample::select(vec!["Bearer", "bearer"]),
            "[A-Za-z]{10,15}",
            "[0-9]{10,15}",
        )
            .prop_map(|(word, letters, digits)| format!("{word} {letters}{digits}"))
            .boxed(),
        // A password in a link.
        ("[a-z]{3,8}", "[A-Za-z0-9]{6,16}", "[a-z]{3,10}")
            .prop_map(|(user, password, host)| format!("https://{user}:{password}@{host}.test/x"))
            .boxed(),
        // A password variable.
        (
            prop::sample::select(vec!["PGPASSWORD", "MYSQL_PWD", "REDISCLI_AUTH", "SSHPASS"]),
            prop::sample::select(vec!["", " "]),
            prop::sample::select(vec!["", " "]),
            prop::sample::select(vec!["", "'", "\""]),
            "[A-Za-z0-9]{4,12}",
        )
            .prop_map(|(name, before, after, quote, value)| {
                format!("{name}{before}={after}{quote}{value}")
            })
            .boxed(),
        // A password on a command line.
        (
            prop::sample::select(vec![
                "mysql -u root -p",
                "mysqldump --password=",
                "mysqladmin -u a -p",
            ]),
            "[A-Za-z0-9]{4,12}",
        )
            .prop_map(|(command, password)| format!("{command}{password}"))
            .boxed(),
        "[A-Za-z0-9]{4,12}"
            .prop_map(|password| format!("sshpass -p {password} ssh host"))
            .boxed(),
        ("[a-z]{3,8}", "[A-Za-z0-9]{4,12}")
            .prop_map(|(user, password)| format!("curl -u {user}:{password} https://host.test"))
            .boxed(),
        (
            prop::sample::select(vec!["-a", "--pass"]),
            "[A-Za-z0-9]{4,12}",
        )
            .prop_map(|(flag, password)| format!("redis-cli {flag} {password}"))
            .boxed(),
        // An assigned secret: a key name, then a long value with a letter and a digit.
        (
            prop::sample::select(vec![
                "api_key",
                "apiKey",
                "API-KEY",
                "apikey",
                "client_secret",
                "secret",
                "token",
                "password",
                "passwd",
                "access_key",
                "ACCESS-KEY",
            ]),
            prop::sample::select(vec!["", "\"", "'"]),
            prop::sample::select(vec!["", " ", "  "]),
            prop::sample::select(vec![":", "="]),
            prop::sample::select(vec!["", " "]),
            prop::sample::select(vec!["", "\"", "'"]),
            ("[A-Za-z]{8,12}", "[0-9]{8,12}"),
        )
            .prop_map(|(key, q1, w1, op, w2, q2, (letters, digits))| {
                format!("{key}{q1}{w1}{op}{w2}{q2}{letters}{digits}")
            })
            .boxed(),
    ];
    Union::new(shapes)
}

/// Text around a secret: empty, printable, or anything at all (unicode, control characters). Never a line break: an
/// added line is one line of a diff.
fn surround() -> impl Strategy<Value = String> {
    prop_oneof![
        1 => Just(String::new()),
        3 => "[ -~]{0,30}",
        2 => any::<String>(),
    ]
    .prop_map(|text| text.replace('\n', " "))
}

/// A character before and after the secret that is not a word character, so the token stands as its own word (every
/// shape with a `\b` in its pattern needs that; a token glued to a letter is not a token).
fn separator() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec![
        " ", "\t", "\"", "'", "=", ":", ",", "(", "[", "{", "/", ";", "|", " — ", "「", "\u{a0}",
    ])
}

/// A secret placed at a random offset inside random text.
fn wrapped() -> impl Strategy<Value = (String, String)> {
    (secret(), surround(), separator(), separator(), surround()).prop_map(
        |(secret, prefix, before, after, suffix)| {
            let line = format!("{prefix}{before}{secret}{after}{suffix}");
            (secret, line)
        },
    )
}

/// A line of ordinary prose: no `:` or `=` (so no assignment), no digits, no links.
fn benign() -> impl Strategy<Value = String> {
    "[a-zA-Z ,.!?]{0,60}"
}

fn path() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "src/app.rs",
        "docs/with space.md",
        "日本語/名前.txt",
        "a b/c d.txt",
        "README.md",
        "deep/er/still/file.toml",
    ])
    .prop_map(str::to_string)
}

// ---- a multi-commit patch -------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct PFile {
    path: String,
    /// The line number of the file's first added line.
    start: usize,
    lines: Vec<String>,
}

#[derive(Clone, Debug)]
struct PCommit {
    sha: String,
    files: Vec<PFile>,
}

fn commit_sha(index: usize) -> String {
    format!("c0ffee{index:02}{}", "0".repeat(32))
}

/// The log's own form: `hivra-commit <sha>` before each commit's diff, one new-file diff per file.
fn render(commits: &[PCommit], eol: &str, nul: bool) -> String {
    let mut out = String::new();
    for commit in commits {
        out.push_str(&format!("hivra-commit {}{eol}", commit.sha));
        for file in &commit.files {
            let p = &file.path;
            out.push_str(&format!(
                "diff --git a/{p} b/{p}{eol}new file mode 100644{eol}index 0000000..1111111{eol}--- /dev/null{eol}+++ b/{p}{eol}@@ -0,0 +{},{} @@{eol}",
                file.start,
                file.lines.len()
            ));
            for line in &file.lines {
                out.push('+');
                if nul {
                    // A UTF-16 file: a NUL after every character.
                    for c in line.chars() {
                        out.push(c);
                        out.push('\0');
                    }
                } else {
                    out.push_str(line);
                }
                out.push_str(eol);
            }
        }
    }
    out
}

type RawCommits = Vec<Vec<(String, usize, Vec<String>)>>;

fn raw_commits() -> impl Strategy<Value = RawCommits> {
    prop::collection::vec(
        prop::collection::vec(
            (path(), 1usize..500, prop::collection::vec(benign(), 1..5)),
            1..4,
        ),
        1..5,
    )
}

fn commits_of(raw: &RawCommits) -> Vec<PCommit> {
    raw.iter()
        .enumerate()
        .map(|(index, files)| PCommit {
            sha: commit_sha(index),
            files: files
                .iter()
                .map(|(path, start, lines)| PFile {
                    path: path.clone(),
                    start: *start,
                    lines: lines.clone(),
                })
                .collect(),
        })
        .collect()
}

fn eol() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec!["\n", "\r\n"])
}

// ---- agent files, in every spelling the fold promises --------------------------------------------------------------

/// One character spelled another way the fold treats as the same: itself, upper case, fullwidth (NFKC), or the long s.
fn respell(text: &str, picks: &[u8]) -> String {
    text.chars()
        .enumerate()
        .map(|(index, c)| match picks[index % picks.len()] {
            1 => c.to_ascii_uppercase().to_string(),
            2 if c.is_ascii_graphic() => char::from_u32(c as u32 + 0xFEE0).unwrap_or(c).to_string(),
            3 if c == 's' || c == 'S' => '\u{17f}'.to_string(),
            3 => c.to_ascii_uppercase().to_string(),
            _ => c.to_string(),
        })
        .collect()
}

/// An agent file's folder names: every folder in the shared list, and the repo's own `.hivra`.
fn agent_folders() -> Vec<String> {
    let mut folders: Vec<String> = shared_list()
        .expect("the shared list loads")
        .folder_names()
        .to_vec();
    folders.extend(AGENT_FOLDERS.iter().map(|folder| folder.to_string()));
    folders
}

/// The kinds of agent file the guard names, as (file name, kind): an approvals file, or a saved transcript.
fn agent_name() -> impl Strategy<Value = (String, &'static str)> {
    prop_oneof![
        Just((APPROVALS_FILE.to_string(), APPROVALS)),
        "[a-z0-9-]{1,12}".prop_map(|stem| (format!("{stem}{TRANSCRIPT_EXT}"), TRANSCRIPT)),
    ]
}

/// What stands before a path and between its names.
fn joiner() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec!["/", "\\", "//", "\\/", "/\\", "/./", "\\.\\"])
}

fn lead() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec!["", "./", ".\\", "/", "\"", " ", "C:\\work\\", "../"])
}

/// The dots and spaces Windows and macOS drop from the end of a name.
fn trailing() -> impl Strategy<Value = &'static str> {
    prop::sample::select(vec!["", "", "", ".", " ", "..", ". ", " . "])
}

// ---- real repositories ---------------------------------------------------------------------------------------------

static SCRATCH: AtomicUsize = AtomicUsize::new(0);

/// A temporary folder for one case, removed when it goes out of scope.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "sc6-commit-guard-{}-{}",
            std::process::id(),
            SCRATCH.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// `git` in `dir`, with no hook, no signing and no user or system config in the way of a test repository.
fn git(dir: &Path, args: &[&str]) -> String {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "core.hooksPath=sc6-no-hooks",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Guard Test",
            "-c",
            "user.email=guard@example.test",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.safecrlf=false",
        ])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", null)
        .env("GIT_CONFIG_SYSTEM", null)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write_bytes(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn commit_all(root: &Path, message: &str) {
    git(root, &["add", "-A", "-f"]);
    git(root, &["commit", "-q", "--allow-empty", "-m", message]);
}

/// A new repository whose first commit (the part already pushed) is `base`; returns the repository and that commit.
fn repo_with_base(attributes: &str) -> (Scratch, String) {
    let dir = Scratch::new();
    git(&dir.0, &["init", "-q", "-b", "main"]);
    write_bytes(&dir.0, "README.md", b"hello\n");
    if !attributes.is_empty() {
        write_bytes(&dir.0, ".gitattributes", attributes.as_bytes());
    }
    commit_all(&dir.0, "base");
    let base = git(&dir.0, &["rev-parse", "HEAD"]);
    (dir, base)
}

#[derive(Clone, Copy, Debug)]
enum Shape {
    /// Commits one after another.
    Linear,
    /// The interesting commit is on a side branch, brought in by a merge commit.
    Merged,
}

fn file_text(lines: &[String], eol: &str, binary: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    if binary {
        // Git marks a file with a NUL near its start as binary and shows no diff for it.
        bytes.extend_from_slice(&[0, 1, 0, 2]);
    }
    bytes.extend_from_slice(lines.join(eol).as_bytes());
    bytes.extend_from_slice(eol.as_bytes());
    bytes
}

proptest! {
    #![proptest_config(config())]

    /// A secret in any shape the patterns list, at any offset inside any text, on an added line of any commit of the
    /// range, is found: in the file and at the line it was added, in the commit that added it, with CRLF line ends or a
    /// UTF-16 file's NULs. The same patch with that line made ordinary is not refused (so the check is not a blanket no),
    /// and the refusal never shows the value.
    #[test]
    fn prop_a_secret_shape_on_an_added_line_is_found_in_the_commit_that_added_it(
        raw in raw_commits(),
        commit_pick in any::<Index>(),
        file_pick in any::<Index>(),
        line_pick in any::<Index>(),
        (secret, line) in wrapped(),
        eol in eol(),
        nul in any::<bool>(),
    ) {
        let without = commits_of(&raw);
        let c = commit_pick.index(without.len());
        let f = file_pick.index(without[c].files.len());
        let l = line_pick.index(without[c].files[f].lines.len());
        let mut with = without.clone();
        with[c].files[f].lines[l] = line.clone();

        let clean = check_patch(&render(&without, eol, nul), &[], "");
        prop_assert!(clean.is_ok(), "an ordinary patch was refused: {:?}", clean);

        let found = check_patch(&render(&with, eol, nul), &[], "");
        let finding = match found {
            Err(finding) => finding,
            Ok(()) => return Err(TestCaseError::fail(format!("a secret got through: {line:?}"))),
        };
        prop_assert_eq!(&finding.file, &with[c].files[f].path);
        prop_assert_eq!(&finding.commit, &with[c].sha);
        prop_assert_eq!(finding.line, with[c].files[f].start + l);
        let text = refusal_text(&finding, Some("/project"), "abc123abc123");
        prop_assert!(!text.contains(&secret), "the refusal shows the value: {}", text);
    }

    /// A private key is found by its whole block however it is written: on separate added lines (with a decoy END before
    /// it, comments around the markers, empty lines in the body), as one line with escaped `\n`s or old-Mac `\r`s, or
    /// with its BEGIN and END added by different commits.
    #[test]
    fn prop_a_private_key_block_is_found_however_it_is_written(
        raw in raw_commits(),
        commit_pick in any::<Index>(),
        kind in prop::sample::select(vec!["", "RSA ", "EC ", "DSA ", "OPENSSH ", "ENCRYPTED "]),
        body in prop::collection::vec("[A-Za-z0-9+/]{0,64}", 0..6),
        layout in 0u8..4,
        decoy in any::<bool>(),
        (before, after) in (surround(), surround()),
        eol in eol(),
        nul in any::<bool>(),
    ) {
        let mut commits = commits_of(&raw);
        let c = commit_pick.index(commits.len());
        let begin = format!("{before}-----BEGIN {kind}PRIVATE KEY-----");
        let end = format!("-----END {kind}PRIVATE KEY-----{after}");
        let key_path = "keys/id with space.txt".to_string();
        let mut key_commits = vec![c];
        let lines: Vec<String> = match layout {
            // One line, the way a JSON string carries it.
            1 => vec![format!("{begin}\\n{}\\n{end}\\n", body.join("\\n"))],
            // One line, the way an old Mac line end splits it (a diff does not split on a lone CR).
            2 => vec![format!("{begin}\r{}\r{end}", body.join("\r"))],
            _ => {
                let mut lines = Vec::new();
                if decoy {
                    // An END before the BEGIN must neither close it nor hide it.
                    lines.push(format!("-----END {kind}PRIVATE KEY-----"));
                }
                lines.push(begin.clone());
                lines.extend(body.iter().cloned());
                lines.push(end.clone());
                lines
            }
        };
        if layout == 3 && commits.len() > 1 && lines.len() > 2 {
            // BEGIN and its body in one commit, END in the next: the push carries the whole key.
            let split = lines.len() - 1;
            let (first, second) = if c + 1 < commits.len() { (c, c + 1) } else { (c - 1, c) };
            commits[first].files.push(PFile {
                path: key_path.clone(),
                start: 1,
                lines: lines[..split].to_vec(),
            });
            commits[second].files.push(PFile {
                path: key_path.clone(),
                start: 1 + split,
                lines: lines[split..].to_vec(),
            });
            key_commits = vec![first, second];
        } else {
            commits[c].files.push(PFile { path: key_path.clone(), start: 1, lines });
        }
        let found = check_patch(&render(&commits, eol, nul), &[], "");
        let finding = match found {
            Err(finding) => finding,
            Ok(()) => return Err(TestCaseError::fail(format!("a private key got through: layout {layout}, {commits:?}"))),
        };
        prop_assert_eq!(&finding.file, &key_path);
        prop_assert!(
            key_commits.iter().any(|index| finding.commit == commits[*index].sha),
            "found in commit {:?}, the key is in {:?}", finding.commit, key_commits
        );
    }

    /// A PGP private key block is a private key. Its BEGIN line ends `PRIVATE KEY BLOCK-----`, which the "Private key"
    /// pattern used to miss (it wanted `PRIVATE KEY-----` right after the words).
    #[test]
    fn prop_a_pgp_private_key_block_is_found(
        raw in raw_commits(),
        commit_pick in any::<Index>(),
        body in prop::collection::vec("[A-Za-z0-9+/]{0,64}", 0..6),
        eol in eol(),
    ) {
        let mut commits = commits_of(&raw);
        let c = commit_pick.index(commits.len());
        let mut lines = vec!["-----BEGIN PGP PRIVATE KEY BLOCK-----".to_string(), String::new()];
        lines.extend(body);
        lines.push("-----END PGP PRIVATE KEY BLOCK-----".to_string());
        commits[c].files.push(PFile { path: "keys/secret.asc".into(), start: 1, lines });
        let found = check_patch(&render(&commits, eol, false), &[], "");
        prop_assert!(found.is_err(), "a PGP private key block got through");
    }

    /// An agent file never passes in any spelling the path fold promises: any case, fullwidth or long-s letters, trailing
    /// dots and spaces, either slash, doubled slashes, `.` steps, a leading `./`, `/`, drive or quote, a NUL inside a
    /// name, folders above it. An ordinary file in an ordinary folder is not an agent file.
    #[test]
    fn prop_an_agent_file_is_found_in_any_spelling_the_path_fold_promises(
        folder_pick in any::<Index>(),
        (name, kind) in agent_name(),
        above in prop::collection::vec(prop::sample::select(vec!["src", "a b", "日本語", "..", "deep"]), 0..3),
        picks in prop::collection::vec(0u8..4, 1..40),
        joins in prop::collection::vec(joiner(), 4),
        lead in lead(),
        tails in prop::collection::vec(trailing(), 2),
        nul_in_folder in any::<bool>(),
    ) {
        let folders = agent_folders();
        let folder = &folders[folder_pick.index(folders.len())];
        let mut spelled_folder = respell(folder, &picks);
        if nul_in_folder {
            // A NUL inside a name is dropped by the fold. Inserted by character, not by byte (fullwidth letters are wide).
            let mut chars: Vec<char> = spelled_folder.chars().collect();
            if chars.len() > 1 {
                chars.insert(1, '\0');
            }
            spelled_folder = chars.into_iter().collect();
        }
        spelled_folder.push_str(tails[0]);
        let mut spelled_name = respell(&name, &picks);
        spelled_name.push_str(tails[1]);
        let mut parts: Vec<String> = above.iter().map(|part| part.to_string()).collect();
        parts.push(spelled_folder);
        parts.push(spelled_name);
        let mut spelled = lead.to_string();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                spelled.push_str(joins[index % joins.len()]);
            }
            spelled.push_str(part);
        }
        prop_assert_eq!(agent_file_kind(&spelled), Ok(Some(kind)), "{:?} was let through", spelled);
        prop_assert!(is_agent_settings_file(&spelled), "{:?} is not held from a copy", spelled);

        // The same names outside any agent folder are ordinary files.
        let plain = format!("src/{}", name);
        prop_assert_eq!(agent_file_kind(&plain), Ok(None), "{:?} was refused", plain);
    }

    /// The same rule at the gate: a real repository, a push of several commits, an agent file in any one of them (an
    /// approvals file or a transcript, in a spelling git can store here) stops the push, and the same push without it
    /// passes.
    #[test]
    fn prop_an_agent_file_in_any_commit_of_a_push_is_refused(
        commits in 2usize..5,
        at in any::<Index>(),
        has_agent in prop::bool::weighted(0.75),
        folder_pick in any::<Index>(),
        (name, _kind) in agent_name(),
        picks in prop::collection::vec(0u8..4, 1..40),
        above in prop::collection::vec(prop::sample::select(vec!["src", "a b", "deep"]), 0..3),
    ) {
        let folders = agent_folders();
        // A file cannot be added under `.git`.
        let usable: Vec<&String> = folders.iter().filter(|f| f.as_str() != ".git").collect();
        let folder = usable[folder_pick.index(usable.len())];
        // Spellings git stores as written on any system this runs on: case, and (off Windows) fullwidth and the long s.
        let picks: Vec<u8> = if cfg!(windows) { picks.iter().map(|p| p % 2).collect() } else { picks };
        let spelled = format!("{}{}{}/{}", above.join("/"), if above.is_empty() { "" } else { "/" }, respell(folder, &picks), respell(&name, &picks));

        let (dir, base) = repo_with_base("");
        let carries = at.index(commits);
        for index in 0..commits {
            write_bytes(&dir.0, &format!("work/file {index}.txt"), b"ordinary\n");
            if has_agent && index == carries {
                write_bytes(&dir.0, &spelled, b"{}\n");
            }
            commit_all(&dir.0, &format!("commit {index}"));
        }
        let got = gate_range(&dir.0, &["HEAD", "--not", &base]);
        if has_agent {
            prop_assert!(got.is_err(), "an agent file ({:?}) in a pushed commit passed the gate", spelled);
            let refused = got.unwrap_err();
            prop_assert!(refused.starts_with("Refused to push "), "{}", refused);
        } else {
            prop_assert!(got.is_ok(), "an ordinary push was refused: {:?}", got);
        }
    }

    /// No push the gate passes carries a secret in any commit. A real repository, a push of several commits (in a line,
    /// or on a branch a merge brings in), the secret in one of them at a random offset in random text, in a file git may
    /// store as binary or with attributes that change its line ends, and perhaps removed again by a later commit (the
    /// push still carries it). The gate refuses every one without showing the value, and passes the same push with no
    /// secret in it.
    #[test]
    fn prop_a_push_with_a_secret_in_any_commit_is_refused(
        commits in 2usize..5,
        has_secret in prop::bool::weighted(0.75),
        at in any::<Index>(),
        (secret, line) in wrapped(),
        lines in prop::collection::vec(benign(), 1..5),
        line_pick in any::<Index>(),
        eol in eol(),
        binary in any::<bool>(),
        attributes in prop::sample::select(vec!["", "* binary\n", "* -diff\n", "* -text\n", "*.txt text eol=crlf\n"]),
        shape in prop::sample::select(vec![Shape::Linear, Shape::Merged]),
        removed_later in any::<bool>(),
    ) {
        let (dir, base) = repo_with_base(attributes);
        let carries = at.index(commits);
        let mut with = lines.clone();
        let slot = line_pick.index(with.len());
        with[slot] = line.clone();
        let text_for = |index: usize| -> Vec<u8> {
            file_text(if has_secret && index == carries { &with } else { &lines }, eol, binary)
        };
        match shape {
            Shape::Linear => {
                for index in 0..commits {
                    write_bytes(&dir.0, &format!("dir {index}/file {index}.txt"), &text_for(index));
                    commit_all(&dir.0, &format!("commit {index}"));
                    if removed_later && index == carries && index + 1 < commits {
                        // The next commit takes the secret out again; the range still contains the commit that added it.
                        write_bytes(&dir.0, &format!("dir {index}/file {index}.txt"), &file_text(&lines, eol, binary));
                        commit_all(&dir.0, "take it out");
                    }
                }
            }
            Shape::Merged => {
                git(&dir.0, &["checkout", "-q", "-b", "side"]);
                write_bytes(&dir.0, &format!("dir {carries}/file {carries}.txt"), &text_for(carries));
                commit_all(&dir.0, "side");
                git(&dir.0, &["checkout", "-q", "main"]);
                for index in (0..commits).filter(|index| *index != carries) {
                    write_bytes(&dir.0, &format!("dir {index}/file {index}.txt"), &text_for(index));
                    commit_all(&dir.0, &format!("commit {index}"));
                }
                git(&dir.0, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
            }
        }
        let got = gate_range(&dir.0, &["HEAD", "--not", &base]);
        if has_secret {
            prop_assert!(got.is_err(), "a secret in a pushed commit passed the gate: {:?}", line);
            let refused = got.unwrap_err();
            prop_assert!(refused.starts_with("Possible secret in "), "{}", refused);
            prop_assert!(!refused.contains(&secret), "the refusal shows the value: {}", refused);
        } else {
            prop_assert!(got.is_ok(), "an ordinary push was refused: {:?}", got);
        }
    }
}
