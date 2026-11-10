//! WP-143: is an Explore agent already defined for a Claude Code session?
//!
//! A hub crew or Mono session on Anthropic gets a cheap Explore agent through Claude Code's `--agents` flag. That
//! flag outranks the agents in `.claude/agents`, so passing it would shadow an Explore the person wrote. This
//! answers that one question, and only reads: it lists folders and reads the top of a few files. It never creates,
//! changes or removes anything, in the project or in the person's Claude config folder.
//!
//! The answer errs toward "defined". A folder that can't be read, a file that can't be opened, a config folder that
//! can't be found or a folder too large to scan all say "defined", so the session starts without the flag instead of
//! shadowing something this couldn't see.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

const AGENT: &str = "explore";
/// Agent files sit in `agents/` or a few folders down. Deeper than this is not an agent folder.
const MAX_DEPTH: u8 = 4;
/// A folder with more entries than this is not an agent folder; it is treated as "defined".
const MAX_ENTRIES: usize = 2000;
/// Only the front of a file is read: the `name:` line is in the frontmatter at the top.
const HEAD_BYTES: u64 = 4096;

/// True when an agent named Explore is defined for a session working in `cwd`, or when that can't be told.
///
/// `provider_account_id` is the Claude account the session runs on: a signed-in profile has its own config folder.
#[tauri::command(async)]
pub fn claude_explore_agent_defined(
    app: AppHandle,
    cwd: String,
    provider_account_id: Option<String>,
) -> bool {
    let config = config_dir(&app, provider_account_id.as_deref());
    explore_defined(config.as_deref(), Path::new(&cwd))
}

/// The folder Claude Code reads its user-level agents from for this account, as the app starts it
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

pub(crate) fn explore_defined(config: Option<&Path>, cwd: &Path) -> bool {
    // A folder this can't reason about is one it can't vouch for.
    if !cwd.is_absolute() || cwd.components().any(|part| part == Component::ParentDir) {
        return true;
    }
    let Some(config) = config else {
        return true;
    };
    let mut folders = vec![config.join("agents")];
    let mut seen: HashSet<PathBuf> = HashSet::new();
    seen.insert(folders[0].clone());
    // Project agents live in `.claude/agents` of the folder or any folder above it, the logical path and the real one.
    let mut starts = vec![cwd.to_path_buf()];
    if let Ok(real) = crate::fs::canonical(cwd) {
        if real != cwd {
            starts.push(real);
        }
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
            if depth < MAX_DEPTH && scan(&path, depth + 1, visited) {
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
        match read_head(&path) {
            Some(head) => {
                if frontmatter_name(&head).is_some_and(|name| name.eq_ignore_ascii_case(AGENT)) {
                    return true;
                }
            }
            None => return true,
        }
    }
    false
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn read_head(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(HEAD_BYTES).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The `name:` of a file's frontmatter, with CRLF, a byte-order mark and quotes handled. Text after the closing `---`
/// is the agent's prompt and is never read as a field.
fn frontmatter_name(text: &str) -> Option<String> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            return None;
        }
        if let Some(rest) = line.strip_prefix("name:") {
            let value = rest.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            return Some(value.to_string());
        }
    }
    None
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
    fn deep_nesting_stops_instead_of_walking_forever() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let mut deep = config.join("agents");
        for index in 0..(MAX_DEPTH as usize + 3) {
            deep = deep.join(format!("d{index}"));
        }
        put(&deep, "Explore.md", "---\nname: Explore\n---\n");
        assert!(!explore_defined(Some(&config), &project));
    }

    #[test]
    fn a_check_changes_nothing_and_a_repository_stays_clean() {
        let scratch = Scratch::new();
        let (project, config) = scratch.pair();
        let init = std::process::Command::new("git")
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
            let status = std::process::Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(&project)
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&status.stdout), "?? README.md\n");
        }
    }

    #[test]
    fn frontmatter_reads_only_the_top_block() {
        assert_eq!(
            frontmatter_name("---\nname: A\n---\nname: B\n"),
            Some("A".into())
        );
        assert_eq!(
            frontmatter_name("---\ndescription: x\n---\nname: B\n"),
            None
        );
        assert_eq!(frontmatter_name("name: A\n"), None);
        assert_eq!(frontmatter_name(""), None);
        assert_eq!(frontmatter_name("---\nname:\n---\n"), Some(String::new()));
    }
}
