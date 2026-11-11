//! WP-143: may a Claude Code session get the cheap Explore flag, or is something already in the way?
//!
//! A hub crew or Mono session on Anthropic gets a cheap Explore agent through Claude Code's `--agents` flag. That
//! flag outranks the agents in `.claude/agents`, so passing it would shadow an Explore the person wrote. This
//! answers that question, and whether the session runs on Bedrock, Vertex, Foundry or another API base URL, and only
//! reads: it lists folders, reads the top of a few files, reads settings files and reads environment variables. It
//! never creates, changes or removes anything, in the project or in the person's Claude config folder.
//!
//! The answer errs toward "blocked". A folder that can't be read, a file that can't be opened or understood, a
//! frontmatter that never closes, a folder too deep or too large to scan, or a config folder that can't be found all
//! say "blocked", so the session starts without the flag instead of shadowing or misrouting something this couldn't
//! see.
//!
//! Settings files are read for the presence of a few `env` names, never for their values: the `env` block can hold
//! keys, so it is parsed with the values skipped, and nothing from it is logged, returned or kept.

use serde::de::IgnoredAny;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

const AGENT: &str = "explore";
/// Agent files sit in `agents/` or a few folders down. A folder deeper than this is not scanned and counts as "defined".
const MAX_DEPTH: u8 = 4;
/// A folder with more entries than this is not an agent folder; it is treated as "defined".
const MAX_ENTRIES: usize = 2000;
/// Only the front of a file is read: the `name:` line is in the frontmatter at the top. A frontmatter that does not
/// close inside this counts as "defined".
const HEAD_BYTES: u64 = 4096;
/// A settings file bigger than this is not read and counts as "not Anthropic".
const SETTINGS_MAX_BYTES: u64 = 1024 * 1024;
/// Environment names that send Claude Code to another backend. A truthy switch, or any non-empty base URL, in the
/// process environment; the bare name in a settings file's `env` block.
const BACKEND_SWITCHES: [&str; 3] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];
const BACKEND_URL: &str = "ANTHROPIC_BASE_URL";

/// True when the session must start without the cheap Explore flag: an agent named Explore is already defined for a
/// session working in `cwd` (or in a folder it adds with `--add-dir`), the environment or a settings file points
/// Claude Code at a backend other than Anthropic's own (Bedrock, Vertex, Foundry or another API base URL, where the
/// `haiku` alias isn't ours to assume), or either can't be told.
///
/// `provider_account_id` is the Claude account the session runs on: a signed-in profile has its own config folder.
/// `add_dirs` are the `--add-dir` folders of the launch; a relative one is relative to `cwd`.
#[tauri::command(async)]
pub fn claude_explore_agent_defined(
    app: AppHandle,
    cwd: String,
    provider_account_id: Option<String>,
    add_dirs: Option<Vec<String>>,
) -> bool {
    let config = config_dir(&app, provider_account_id.as_deref());
    flag_blocked(
        |key| std::env::var(key).ok(),
        config.as_deref(),
        Path::new(&cwd),
        &add_dirs.unwrap_or_default(),
    )
}

/// The folder Claude Code reads its user-level agents and settings from for this account, as the app starts it
/// (`harness.rs`, `instance.rs`): a profile's own folder, a dev copy's shared folder, `CLAUDE_CONFIG_DIR`, or
/// `~/.claude`. `None` when it can't be worked out.
fn config_dir(app: &AppHandle, account: Option<&str>) -> Option<PathBuf> {
    if let Some(id) = account.filter(|id| !id.is_empty() && *id != "default") {
        return crate::harness::provider_account_path(app, "claude", id).ok();
    }
    match crate::instance::dev_claude_config_dir() {
        Ok(Some(dir)) => Some(dir),
        Ok(None) => std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| crate::dirs_home().map(|home| PathBuf::from(home).join(".claude"))),
        Err(_) => None,
    }
}

/// The whole answer, with the environment and the folders passed in so a test can stand in for them.
pub(crate) fn flag_blocked(
    env: impl Fn(&str) -> Option<String>,
    config: Option<&Path>,
    cwd: &Path,
    add_dirs: &[String],
) -> bool {
    other_backend_selected(&env)
        || settings_select_other_backend(config, cwd)
        || explore_defined_with(config, cwd, add_dirs)
}

/// True when the environment Claude Code starts in selects Bedrock, Vertex or Foundry, or another API base URL.
/// A session the hub routes to an Other model is already kept off the flag by its launch; this covers a person who
/// runs Claude Code on another backend through their own environment. Only the process environment is read here.
pub(crate) fn other_backend_selected(env: impl Fn(&str) -> Option<String>) -> bool {
    let on = |value: String| {
        let value = value.trim().to_ascii_lowercase();
        !matches!(value.as_str(), "" | "0" | "false" | "no" | "off")
    };
    BACKEND_SWITCHES.iter().any(|key| env(key).is_some_and(on))
        || env(BACKEND_URL).is_some_and(|url| !url.trim().is_empty())
}

fn has_parent_dir(path: &Path) -> bool {
    path.components().any(|part| part == Component::ParentDir)
}

/// Where a folder is looked at: as given, and as it really is (a link or a different spelling of the same place).
fn spellings(folder: &Path) -> Vec<PathBuf> {
    let mut out = vec![folder.to_path_buf()];
    if let Ok(real) = crate::fs::canonical(folder) {
        if real != folder {
            out.push(real);
        }
    }
    out
}

/// The agents check for a session that adds no folders.
#[cfg(test)]
fn explore_defined(config: Option<&Path>, cwd: &Path) -> bool {
    explore_defined_with(config, cwd, &[])
}

/// True when an agent named Explore is defined for a session in `cwd` that also adds `add_dirs`, or when that can't be
/// told. Claude Code may not read every added folder's agents, but a folder it might read is a folder checked.
pub(crate) fn explore_defined_with(config: Option<&Path>, cwd: &Path, add_dirs: &[String]) -> bool {
    // A folder this can't reason about is one it can't vouch for.
    if !cwd.is_absolute() || has_parent_dir(cwd) {
        return true;
    }
    let Some(config) = config else {
        return true;
    };
    let mut folders = vec![config.join("agents")];
    let mut seen: HashSet<PathBuf> = HashSet::new();
    seen.insert(folders[0].clone());
    // Project agents live in `.claude/agents` of the folder or any folder above it, the logical path and the real one.
    let mut starts = spellings(cwd);
    for dir in add_dirs.iter().filter(|dir| !dir.trim().is_empty()) {
        let dir = Path::new(dir);
        let dir = if dir.is_absolute() {
            dir.to_path_buf()
        } else {
            cwd.join(dir)
        };
        if has_parent_dir(&dir) {
            return true;
        }
        starts.extend(spellings(&dir));
    }
    for start in starts {
        for above in start.ancestors() {
            let folder = above.join(".claude").join("agents");
            if seen.insert(folder.clone()) {
                folders.push(folder);
            }
        }
    }
    folders.iter().any(|folder| folder_defines_explore(folder))
}

fn folder_defines_explore(folder: &Path) -> bool {
    let mut visited = 0;
    scan(folder, 0, &mut visited)
}

/// True when `dir` holds an Explore agent, or when it can't be told.
fn scan(dir: &Path, depth: u8, visited: &mut usize) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return true;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return true;
        };
        *visited += 1;
        if *visited > MAX_ENTRIES {
            return true;
        }
        let path = entry.path();
        // A link that points nowhere is not an agent.
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            // Too deep to scan is too deep to vouch for.
            if depth >= MAX_DEPTH || scan(&path, depth + 1, visited) {
                return true;
            }
            continue;
        }
        if !meta.is_file() || !is_markdown(&path) {
            continue;
        }
        let stem = path.file_stem().and_then(|stem| stem.to_str());
        if stem.is_some_and(|stem| stem.eq_ignore_ascii_case(AGENT)) {
            return true;
        }
        let Some(head) = read_head(&path) else {
            return true;
        };
        match frontmatter(&head.text) {
            Front::Named(name) if name.eq_ignore_ascii_case(AGENT) => return true,
            // A frontmatter that never closed in what was read: its name may be in what wasn't.
            Front::Unclosed => return true,
            // The first line alone was longer than what is read.
            Front::Absent if head.truncated && head.text.trim().is_empty() => return true,
            _ => {}
        }
    }
    false
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

/// The front of a file, whole lines only.
struct Head {
    text: String,
    /// The file is longer than what was read.
    truncated: bool,
}

fn read_head(path: &Path) -> Option<Head> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(HEAD_BYTES + 1).read_to_end(&mut bytes).ok()?;
    let truncated = bytes.len() as u64 > HEAD_BYTES;
    if truncated {
        bytes.truncate(HEAD_BYTES as usize);
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        // The last line was cut mid-way: `name: Expl` is not a name.
        match text.rfind('\n') {
            Some(end) => text.truncate(end + 1),
            None => text.clear(),
        }
    }
    Some(Head { text, truncated })
}

/// What a file's frontmatter says about its name.
#[derive(Debug, PartialEq)]
enum Front {
    /// A `name:` line, before the frontmatter closed or ran out.
    Named(String),
    /// The frontmatter closed and none of its lines was a name.
    Closed,
    /// The frontmatter began and never closed in what was read, and had no name line.
    Unclosed,
    /// The file does not begin with a frontmatter.
    Absent,
}

/// A file's frontmatter name, with CRLF, a byte-order mark, blank lines before it, quotes, a spaced colon and a
/// trailing comment handled. Text after the closing `---` is the agent's prompt and is never read as a field.
fn frontmatter(text: &str) -> Front {
    let mut lines = text
        .trim_start_matches('\u{feff}')
        .lines()
        .skip_while(|line| line.trim().is_empty());
    if lines.next().map(str::trim) != Some("---") {
        return Front::Absent;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            return Front::Closed;
        }
        if let Some(name) = name_value(line) {
            return Front::Named(name);
        }
    }
    Front::Unclosed
}

fn name_value(line: &str) -> Option<String> {
    let (key, value) = line.split_once(':')?;
    if key.trim().trim_matches(|c| c == '"' || c == '\'').trim() != "name" {
        return None;
    }
    let value = value.split(" #").next().unwrap_or(value);
    Some(
        value
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .trim()
            .to_string(),
    )
}

/// True when a settings file in the session's config folder, or one in the project (the folder or any folder above
/// it), names a backend switch or base URL in its `env` block, or when that can't be told. Presence only.
fn settings_select_other_backend(config: Option<&Path>, cwd: &Path) -> bool {
    if !cwd.is_absolute() || has_parent_dir(cwd) {
        return true;
    }
    let mut files: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    if let Some(config) = config {
        let file = config.join("settings.json");
        seen.insert(file.clone());
        files.push(file);
    }
    for start in spellings(cwd) {
        for above in start.ancestors() {
            let folder = above.join(".claude");
            if !folder.is_dir() {
                continue;
            }
            let Ok(entries) = fs::read_dir(&folder) else {
                return true;
            };
            for entry in entries {
                let Ok(entry) = entry else {
                    return true;
                };
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if name.starts_with("settings") && name.ends_with(".json") {
                    let file = entry.path();
                    if seen.insert(file.clone()) {
                        files.push(file);
                    }
                }
            }
        }
    }
    files.iter().any(|file| settings_name_other_backend(file))
}

/// The one part of a settings file this reads: the names in `env`. The values are skipped as the file is parsed.
#[derive(serde::Deserialize)]
struct SettingsEnv {
    #[serde(default)]
    env: Option<BTreeMap<String, IgnoredAny>>,
}

/// True when `file` names a backend switch or base URL in its `env` block, or can't be read or understood.
fn settings_name_other_backend(file: &Path) -> bool {
    let meta = match fs::metadata(file) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    if !meta.is_file() {
        return false;
    }
    if meta.len() > SETTINGS_MAX_BYTES {
        return true;
    }
    let Ok(bytes) = fs::read(file) else {
        return true;
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return true;
    };
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        return false;
    }
    let Ok(settings) = serde_json::from_str::<SettingsEnv>(text) else {
        return true;
    };
    settings.env.is_some_and(|env| {
        env.keys().any(|name| {
            BACKEND_SWITCHES
                .iter()
                .chain(std::iter::once(&BACKEND_URL))
                .any(|wanted| name.eq_ignore_ascii_case(wanted))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "explore-agent-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            // The real path, so a /var link on macOS does not make two spellings of one folder.
            let dir = crate::fs::canonical(&dir).unwrap();
            Self { dir }
        }

        fn path(&self) -> &Path {
            &self.dir
        }

        /// A project folder and a Claude config folder, both empty.
        fn pair(&self) -> (PathBuf, PathBuf) {
            let project = self.dir.join("my projéct");
            let config = self.dir.join("config");
            fs::create_dir_all(&project).unwrap();
            fs::create_dir_all(&config).unwrap();
            (project, config)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn put(dir: &Path, name: &str, text: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(name), text).unwrap();
    }

    /// Every path under `root`, so a test can prove a call changed nothing.
    fn tree(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                out.push(path.strip_prefix(root).unwrap().display().to_string());
                if path.is_dir() {
                    stack.push(path);
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn nothing_defined_means_the_flag_may_be_passed() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        assert!(!explore_defined(Some(&config), &project));
        // Other agents are not Explore.
        put(
            &config.join("agents"),
            "reviewer.md",
            "---\nname: Reviewer\ndescription: x\n---\n\nname: Explore\n",
        );
        put(
            &project.join(".claude/agents"),
            "Plan.md",
            "---\nname: Plan\n---\n",
        );
        assert!(!explore_defined(Some(&config), &project));
    }

    #[test]
    fn a_user_level_explore_is_found_by_file_name_or_by_its_name_field() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let agents = config.join("agents");
        put(&agents, "Explore.md", "no frontmatter at all\n");
        assert!(explore_defined(Some(&config), &project));
        fs::remove_file(agents.join("Explore.md")).unwrap();
        assert!(!explore_defined(Some(&config), &project));
        put(&agents, "EXPLORE.MD", "");
        assert!(explore_defined(Some(&config), &project));
        fs::remove_file(agents.join("EXPLORE.MD")).unwrap();

        let spellings = [
            "---\nname: Explore\n---\n",
            "---\r\nname: explore\r\ndescription: x\r\n---\r\n",
            "\u{feff}---\nname: \"Explore\"\n---\n",
            "---\ndescription: x\nname: 'Explore'  \n---\n",
        ];
        for (index, text) in spellings.into_iter().enumerate() {
            let file = format!("mine-{index}.md");
            put(&agents, &file, text);
            assert!(explore_defined(Some(&config), &project), "{text:?}");
            fs::remove_file(agents.join(file)).unwrap();
        }
        assert!(!explore_defined(Some(&config), &project));
    }

    #[test]
    fn a_nested_folder_and_a_non_markdown_file() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        put(&config.join("agents"), "Explore.txt", "name: Explore\n");
        put(
            &config.join("agents"),
            "notes.json",
            "{\"name\":\"Explore\"}",
        );
        assert!(!explore_defined(Some(&config), &project));
        put(
            &config.join("agents/team/search"),
            "finder.md",
            "---\nname: Explore\n---\n",
        );
        assert!(explore_defined(Some(&config), &project));
    }

    #[test]
    fn a_project_explore_is_found_in_the_folder_or_any_folder_above() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let deep = project.join("packages/app");
        fs::create_dir_all(&deep).unwrap();
        assert!(!explore_defined(Some(&config), &deep));
        put(
            &project.join(".claude/agents"),
            "Explore.md",
            "---\nname: Explore\n---\n",
        );
        assert!(explore_defined(Some(&config), &project));
        assert!(explore_defined(Some(&config), &deep));
        // A different project next to it is not affected.
        let other = scratch.path().join("other");
        fs::create_dir_all(&other).unwrap();
        assert!(!explore_defined(Some(&config), &other));
    }

    #[test]
    fn what_cannot_be_checked_counts_as_defined() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        assert!(explore_defined(None, &project));
        assert!(explore_defined(
            Some(&config),
            Path::new("relative/project")
        ));
        assert!(explore_defined(Some(&config), Path::new("")));
        let escaped = project.join("..").join("elsewhere");
        assert!(explore_defined(Some(&config), &escaped));
    }

    #[test]
    fn a_folder_too_big_to_scan_counts_as_defined() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let agents = config.join("agents");
        fs::create_dir_all(&agents).unwrap();
        for index in 0..=MAX_ENTRIES {
            fs::write(agents.join(format!("a{index}.txt")), "").unwrap();
        }
        assert!(explore_defined(Some(&config), &project));
    }

    #[test]
    fn a_folder_too_deep_to_scan_counts_as_defined() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let mut deep = config.join("agents");
        for index in 0..(MAX_DEPTH as usize + 3) {
            deep = deep.join(format!("d{index}"));
        }
        // Nothing is named Explore down there, but the scan stopped before it could say so.
        put(&deep, "other.md", "---\nname: Other\n---\n");
        assert!(explore_defined(Some(&config), &project));
        // Exactly as deep as it will go is still scanned, and says what it holds.
        let mut edge = scratch.path().join("edge-config/agents");
        for index in 0..MAX_DEPTH {
            edge = edge.join(format!("d{index}"));
        }
        put(&edge, "other.md", "---\nname: Other\n---\n");
        assert!(!explore_defined(
            Some(&scratch.path().join("edge-config")),
            &project
        ));
    }

    #[test]
    fn a_check_changes_nothing_and_a_repository_stays_clean() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let init = crate::git_cmd::git()
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        put(&project, "README.md", "hello\n");
        put(
            &config.join("agents"),
            "other.md",
            "---\nname: Other\n---\n",
        );
        let before_project = tree(&project);
        let before_config = tree(&config);

        assert!(!explore_defined(Some(&config), &project));
        assert!(!explore_defined(Some(&config), &project));

        assert_eq!(tree(&project), before_project);
        assert_eq!(tree(&config), before_config);
        assert!(!project.join(".claude").exists());
        if init {
            let status = crate::git_cmd::git()
                .args(["status", "--porcelain"])
                .current_dir(&project)
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&status.stdout), "?? README.md\n");
        }
    }

    fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn a_plain_environment_is_anthropic() {
        assert!(!other_backend_selected(env_of(&[])));
        assert!(!other_backend_selected(env_of(&[
            ("ANTHROPIC_API_KEY", "sk-test"),
            ("PATH", "/usr/bin"),
        ])));
    }

    #[test]
    fn bedrock_vertex_and_foundry_are_not_anthropic() {
        for key in [
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ] {
            for on in ["1", "true", "TRUE", "yes", " 1 "] {
                assert!(other_backend_selected(env_of(&[(key, on)])), "{key}={on}");
            }
            for off in ["", " ", "0", "false", "False", "no", "off"] {
                assert!(
                    !other_backend_selected(env_of(&[(key, off)])),
                    "{key}={off:?}"
                );
            }
        }
    }

    #[test]
    fn another_api_base_url_is_not_anthropic() {
        assert!(other_backend_selected(env_of(&[(
            "ANTHROPIC_BASE_URL",
            "https://openrouter.ai/api"
        )])));
        assert!(!other_backend_selected(env_of(&[(
            "ANTHROPIC_BASE_URL",
            ""
        )])));
        assert!(!other_backend_selected(env_of(&[(
            "ANTHROPIC_BASE_URL",
            "  "
        )])));
    }

    #[test]
    fn frontmatter_reads_only_the_top_block() {
        assert_eq!(
            frontmatter("---\nname: A\n---\nname: B\n"),
            Front::Named("A".into())
        );
        assert_eq!(
            frontmatter("---\ndescription: x\n---\nname: B\n"),
            Front::Closed
        );
        assert_eq!(frontmatter("name: A\n"), Front::Absent);
        assert_eq!(frontmatter(""), Front::Absent);
        assert_eq!(
            frontmatter("---\nname:\n---\n"),
            Front::Named(String::new())
        );
        assert_eq!(frontmatter("---\ndescription: x\n"), Front::Unclosed);
        assert_eq!(frontmatter("---\n"), Front::Unclosed);
    }

    #[test]
    fn an_unclosed_frontmatter_counts_as_defined() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let agents = config.join("agents");
        // Closed, no name: certainly not Explore.
        put(&agents, "closed.md", "---\ndescription: x\n---\nbody\n");
        assert!(!explore_defined(Some(&config), &project));
        // Never closed and no name line: whatever it is called, it can't be ruled out.
        put(&agents, "open.md", "---\ndescription: x\nmodel: haiku\n");
        assert!(explore_defined(Some(&config), &project));
        fs::remove_file(agents.join("open.md")).unwrap();
        assert!(!explore_defined(Some(&config), &project));
        // Unclosed but named something else is that other agent.
        put(&agents, "named.md", "---\nname: Reviewer\ndescription: x\n");
        assert!(!explore_defined(Some(&config), &project));
        // Unclosed and named Explore.
        put(&agents, "mine.md", "---\nname: Explore\n");
        assert!(explore_defined(Some(&config), &project));
    }

    #[test]
    fn a_name_past_the_part_that_is_read_counts_as_defined() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let agents = config.join("agents");
        let filler = "y".repeat(HEAD_BYTES as usize + 500);
        put(
            &agents,
            "long.md",
            &format!("---\ndescription: {filler}\nname: Explore\n---\nbody\n"),
        );
        assert!(explore_defined(Some(&config), &project));
        fs::remove_file(agents.join("long.md")).unwrap();
        assert!(!explore_defined(Some(&config), &project));

        // The cut falls inside the name line: `name: Expl` is not a name, and is not read as one.
        let prefix = "---\ndescription: ";
        let pad = HEAD_BYTES as usize - prefix.len() - "\nname: Expl".len();
        let text = format!("{prefix}{}\nname: Explore\n---\nbody\n", "z".repeat(pad));
        assert_eq!(
            &text.as_bytes()[..HEAD_BYTES as usize][text.find("name:").unwrap()..],
            b"name: Expl"
        );
        put(&agents, "cut.md", &text);
        assert!(explore_defined(Some(&config), &project));
        fs::remove_file(agents.join("cut.md")).unwrap();

        // A long file whose frontmatter closed inside what was read, with no name, is still not Explore.
        put(
            &agents,
            "big.md",
            &format!(
                "---\ndescription: x\n---\n{}",
                "b".repeat(HEAD_BYTES as usize * 3)
            ),
        );
        assert!(!explore_defined(Some(&config), &project));
        // A first line longer than what is read can't be ruled out.
        put(&agents, "wide.md", &"-".repeat(HEAD_BYTES as usize + 10));
        assert!(explore_defined(Some(&config), &project));
    }

    #[test]
    fn other_spellings_of_the_name_line_are_found() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let agents = config.join("agents");
        let spellings = [
            "\n\n---\nname: Explore\n---\n",
            "---\nname : Explore\n---\n",
            "---\n\"name\": \"Explore\"\n---\n",
            "---\nname: Explore # my own search agent\n---\n",
            "---\n  name: explore\n---\n",
        ];
        for (index, text) in spellings.into_iter().enumerate() {
            let file = format!("mine-{index}.md");
            put(&agents, &file, text);
            assert!(explore_defined(Some(&config), &project), "{text:?}");
            fs::remove_file(agents.join(file)).unwrap();
        }
        assert!(!explore_defined(Some(&config), &project));
        put(&agents, "close.md", "---\nname: Explorer\n---\n");
        assert!(!explore_defined(Some(&config), &project));
    }

    #[test]
    fn a_folder_the_session_adds_is_checked_too() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let shared = scratch.path().join("shared");
        fs::create_dir_all(shared.join("libs")).unwrap();
        let add =
            |dirs: &[&str]| -> Vec<String> { dirs.iter().map(|dir| dir.to_string()).collect() };
        let absolute = shared.display().to_string();
        assert!(!explore_defined_with(
            Some(&config),
            &project,
            &add(&[&absolute])
        ));

        put(
            &shared.join(".claude/agents"),
            "Explore.md",
            "---\nname: Explore\n---\n",
        );
        // Without the added folder the project alone has none.
        assert!(!explore_defined_with(Some(&config), &project, &[]));
        assert!(explore_defined_with(
            Some(&config),
            &project,
            &add(&[&absolute])
        ));
        // A folder inside it, and a second folder listed after a clean one.
        let inner = shared.join("libs").display().to_string();
        assert!(explore_defined_with(
            Some(&config),
            &project,
            &add(&[&inner])
        ));
        let clean = scratch.path().join("clean");
        fs::create_dir_all(&clean).unwrap();
        let clean = clean.display().to_string();
        assert!(explore_defined_with(
            Some(&config),
            &project,
            &add(&[&clean, &absolute])
        ));
        // A relative folder is relative to the project.
        let sub = project.join("vendor/shared");
        put(
            &sub.join(".claude/agents"),
            "Explore.md",
            "---\nname: Explore\n---\n",
        );
        assert!(explore_defined_with(
            Some(&config),
            &project,
            &add(&["vendor/shared"])
        ));
        assert!(!explore_defined_with(
            Some(&config),
            &project,
            &add(&["vendor/other"])
        ));
        // Blank entries are ignored; one that climbs out with `..` can't be vouched for.
        assert!(!explore_defined_with(
            Some(&config),
            &project,
            &add(&["", "  "])
        ));
        assert!(explore_defined_with(
            Some(&config),
            &project,
            &add(&["../shared"])
        ));
    }

    #[test]
    fn a_settings_env_block_naming_another_backend_is_not_anthropic() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        assert!(!settings_select_other_backend(Some(&config), &project));
        for name in [
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "ANTHROPIC_BASE_URL",
        ] {
            // The value is not looked at: even an off value, or one that is not a string, is the name present.
            for value in ["\"1\"", "\"0\"", "\"\"", "false", "{\"nested\": 1}"] {
                put(
                    &config,
                    "settings.json",
                    &format!("{{\"env\": {{\"OTHER\": \"x\", \"{name}\": {value}}}}}"),
                );
                assert!(
                    settings_select_other_backend(Some(&config), &project),
                    "{name}={value}"
                );
            }
        }
        // Other env names, other keys and an empty or missing env block say nothing.
        for body in [
            "{\"env\": {\"EDITOR\": \"vim\", \"ANTHROPIC_MODEL\": \"x\"}}",
            "{\"env\": {}}",
            "{\"env\": null}",
            "{\"permissions\": {\"allow\": [\"CLAUDE_CODE_USE_BEDROCK\"]}, \"model\": \"ANTHROPIC_BASE_URL\"}",
            "{}",
            "",
            "  \n",
            "\u{feff}{}",
        ] {
            put(&config, "settings.json", body);
            assert!(!settings_select_other_backend(Some(&config), &project), "{body:?}");
        }
    }

    #[test]
    fn a_project_settings_file_is_read_too() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let deep = project.join("packages/app");
        fs::create_dir_all(&deep).unwrap();
        for file in ["settings.json", "settings.local.json", "settings.team.json"] {
            let dir = project.join(".claude");
            put(
                &dir,
                file,
                "{\"env\": {\"CLAUDE_CODE_USE_BEDROCK\": \"1\"}}",
            );
            assert!(
                settings_select_other_backend(Some(&config), &project),
                "{file}"
            );
            // From a folder below it too, but not from a project next to it.
            assert!(
                settings_select_other_backend(Some(&config), &deep),
                "{file}"
            );
            let other = scratch.path().join("other");
            fs::create_dir_all(&other).unwrap();
            assert!(
                !settings_select_other_backend(Some(&config), &other),
                "{file}"
            );
            fs::remove_file(dir.join(file)).unwrap();
        }
        assert!(!settings_select_other_backend(Some(&config), &project));
        // A file that is not settings is not read.
        put(
            &project.join(".claude"),
            "notes.json",
            "{\"env\": {\"ANTHROPIC_BASE_URL\": \"x\"}}",
        );
        assert!(!settings_select_other_backend(Some(&config), &project));
    }

    #[test]
    fn a_settings_file_that_cannot_be_understood_counts_as_not_anthropic() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        for body in [
            "{not json",
            "[1, 2]",
            "{\"env\": \"CLAUDE_CODE_USE_BEDROCK=1\"}",
            "{\"env\": {\"A\": 1},}",
        ] {
            put(&config, "settings.json", body);
            assert!(
                settings_select_other_backend(Some(&config), &project),
                "{body:?}"
            );
        }
        fs::write(config.join("settings.json"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(settings_select_other_backend(Some(&config), &project));
        let big = format!(
            "{{\"pad\": \"{}\"}}",
            "x".repeat(SETTINGS_MAX_BYTES as usize)
        );
        put(&config, "settings.json", &big);
        assert!(settings_select_other_backend(Some(&config), &project));
        // A folder that can't be reasoned about, as for agents.
        put(&config, "settings.json", "{}");
        assert!(settings_select_other_backend(
            Some(&config),
            Path::new("relative")
        ));
        // No config folder is no config settings; the project's are still read.
        assert!(!settings_select_other_backend(None, &project));
    }

    #[test]
    fn the_whole_answer_puts_the_three_checks_together() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let none = |_: &str| None;
        assert!(!flag_blocked(none, Some(&config), &project, &[]));
        // The process environment.
        assert!(flag_blocked(
            |key: &str| (key == "CLAUDE_CODE_USE_VERTEX").then(|| "1".to_string()),
            Some(&config),
            &project,
            &[]
        ));
        // The session's own settings.
        put(
            &config,
            "settings.json",
            "{\"env\": {\"ANTHROPIC_BASE_URL\": \"https://gw\"}}",
        );
        assert!(flag_blocked(none, Some(&config), &project, &[]));
        put(&config, "settings.json", "{}");
        assert!(!flag_blocked(none, Some(&config), &project, &[]));
        // An Explore.
        put(&config.join("agents"), "Explore.md", "x");
        assert!(flag_blocked(none, Some(&config), &project, &[]));
    }

    #[test]
    fn reading_settings_changes_nothing() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        put(
            &config,
            "settings.json",
            "{\"env\": {\"ANTHROPIC_API_KEY\": \"sk-ant-secret\"}}",
        );
        put(
            &project.join(".claude"),
            "settings.local.json",
            "{\"env\": {\"X\": \"1\"}}",
        );
        let before_project = tree(&project);
        let before_config = tree(&config);
        let settings = fs::read(config.join("settings.json")).unwrap();
        assert!(!flag_blocked(|_: &str| None, Some(&config), &project, &[]));
        assert_eq!(tree(&project), before_project);
        assert_eq!(tree(&config), before_config);
        assert_eq!(fs::read(config.join("settings.json")).unwrap(), settings);
    }
}
