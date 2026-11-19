//! Review r7 repro tests for PR #208 (WP-178), red at e0efac876. Each states a property the profile should hold.
//! The deny regexes are evaluated with the `regex` crate, the same way the earlier rounds' review tests do.

use super::*;

fn filter_matches(line: &str, path: &str) -> bool {
    if let Some(start) = line.find("(regex #\"") {
        let rest = &line[start + "(regex #\"".len()..];
        return rest
            .find("\")")
            .is_some_and(|end| regex::Regex::new(&rest[..end]).is_ok_and(|re| re.is_match(path)));
    }
    for (open, subpath) in [("(literal \"", false), ("(subpath \"", true)] {
        if let Some(start) = line.find(open) {
            let rest = &line[start + open.len()..];
            let Some(end) = rest.find('"') else {
                return false;
            };
            let named = &rest[..end];
            return path == named
                || (subpath && path.starts_with(&format!("{}/", named.trim_end_matches('/'))));
        }
    }
    false
}

/// A deny that refuses writing `path`, or unlinking it (replacing a link node is an unlink and a create).
fn denies_change(profile: &str, path: &Path) -> bool {
    let path = path.to_string_lossy();
    profile.lines().any(|line| {
        let line = line.trim();
        line.starts_with("(deny ")
            && (line.contains("file-write*") || line.contains("file-write-unlink"))
            && filter_matches(line, &path)
    })
}

fn scratch(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("as-r7-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(&dir).unwrap()
}

/// HIGH (r6-4 and r6-9 fixed for bin and Cellar only): on Apple Silicon the whole `/opt/homebrew` tree belongs to the
/// person, and the profile write-denies only `bin`, `Cellar`, `etc/gitconfig` and `lib/node_modules`. Three places in
/// it run outside the sandbox:
/// - `Library/Homebrew` is brew's own code. Homebrew's installer has every user add
///   `eval "$(/opt/homebrew/bin/brew shellenv)"` to `~/.zprofile`, and `bin/brew` runs `Library/Homebrew/brew.sh`.
///   Ash's next terminal (the app's own `pty.rs` login shell, Terminal.app) runs an agent's edit there. The Intel
///   layout's `/usr/local/Homebrew` is denied; the Apple Silicon one is not.
/// - `Caskroom` holds the real binary of a cask: `brew install --cask codex` (and `claude-code`) links
///   `/opt/homebrew/bin/codex` to `Caskroom/codex/<version>/codex-aarch64-apple-darwin`. The kernel checks the
///   resolved path, so `cp evil /opt/homebrew/bin/codex` writes the Caskroom file. The resolver returns
///   `/opt/homebrew/bin/codex`, and the app runs it outside the sandbox through `exec_output`: `harness_exec
///   --version` (the update notice's `inspectHarnessBinary` at launch; for a cask `claude`, every crew or Mono
///   session start, claude.ts `cli.version`), `mcp_command` and `harness_update`. The terminal mirror runs a cask
///   `claude` unwrapped too.
/// - `opt/<formula>` are links into Cellar that every Homebrew binary loads its libraries through: Homebrew git
///   loads `/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib` and `/opt/homebrew/opt/gettext/lib/libintl.8.dylib`.
///   Replacing the link (unlink and create in `opt`) points it at the agent's own dylib, which Ash's Commit, Push,
///   Pull or Fetch (`git_with_hooks`, never sandboxed) then loads.
#[test]
fn homebrews_own_code_casks_and_library_links_cannot_be_rewritten() {
    let profile = profile_text(Path::new("/Users/test")).unwrap();
    assert!(
        denies_change(&profile, Path::new("/opt/homebrew/bin/gh")),
        "precondition: Homebrew's bin is write-denied"
    );
    let open: Vec<&str> = [
        "/opt/homebrew/Library/Homebrew/brew.sh",
        "/opt/homebrew/Library/Homebrew/cmd/shellenv.sh",
        "/opt/homebrew/Caskroom/codex/0.55.0/codex-aarch64-apple-darwin",
        "/opt/homebrew/Caskroom/claude-code/2.0.30/claude",
        "/opt/homebrew/opt/pcre2",
        "/opt/homebrew/opt/gettext",
    ]
    .into_iter()
    .filter(|path| !denies_change(&profile, Path::new(path)))
    .collect();
    assert!(
        open.is_empty(),
        "an agent can change these, and a login shell or the app's unwrapped git and CLI probes run them: {open:?}"
    );
}

/// HIGH (r6-4 fix is by name only): the profile write-denies the folders the resolvers search (`~/.npm-global/bin`,
/// `~/.bun/bin`), but a CLI in them is a link into a package folder that stays writable. The kernel checks the
/// resolved path, so an agent edits `~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js` (or writes through the
/// link). `resolve_codex` returns `~/.npm-global/bin/codex` or `~/.bun/bin/codex`, and the app runs it outside the
/// sandbox through `exec_output`: `harness_exec --version` (the update notice's `inspectHarnessBinary` at launch),
/// `mcp_command` and `harness_update`. For an npm `claude`, every crew or Mono session start runs `--version` the same
/// way (claude.ts `cli.version`), and so does the terminal mirror. Deny the real target of each resolved CLI (and its
/// package folder), not only the folder name.
#[test]
fn a_write_through_a_link_cannot_reach_a_cli_the_app_runs_outside_the_sandbox() {
    let home = scratch("links");
    let mut links = Vec::new();
    for (bin, target) in [
        (
            ".npm-global/bin/codex",
            ".npm-global/lib/node_modules/@openai/codex/bin/codex.js",
        ),
        (
            ".npm-global/bin/claude",
            ".npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        ),
        (
            ".bun/bin/codex",
            ".bun/install/global/node_modules/@openai/codex/bin/codex.js",
        ),
    ] {
        let real = home.join(target);
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, "#!/usr/bin/env node\n").unwrap();
        let link = home.join(bin);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        links.push(link);
    }
    let profile = profile_with_checkouts(&home, None, &[]).unwrap();
    let mut open = Vec::new();
    for link in &links {
        assert!(
            denies_change(&profile, link),
            "precondition: the resolver folder itself is write-denied ({})",
            link.display()
        );
        let real = std::fs::canonicalize(link).unwrap();
        if !denies_change(&profile, &real) {
            open.push(real.display().to_string());
        }
    }
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        open.is_empty(),
        "a write through the denied link lands here, and the app runs it outside the sandbox: {open:?}"
    );
}

/// HIGH (r6-9 fix parses only a line that starts with `source` or `.`, and skips any operand with `$`): installers
/// write lines in other shapes. The Google Cloud SDK installer appends, verbatim,
/// `if [ -f '<home>/google-cloud-sdk/path.zsh.inc' ]; then . '<home>/google-cloud-sdk/path.zsh.inc'; fi`, where the
/// command after `;` starts with `then`. iTerm2's shell integration appends
/// `test -e "${HOME}/.iterm2_shell_integration.zsh" && source "${HOME}/.iterm2_shell_integration.zsh"`, whose operand
/// has `$` and is not one of the fixed names. An agent appends a line to either file; Ash's next terminal (the app's
/// own login shell in `pty.rs`, never wrapped, or Terminal.app / iTerm2) runs it.
#[test]
fn the_files_installers_have_a_login_shell_source_cannot_be_written() {
    let home = scratch("installers");
    let h = home.display().to_string();
    std::fs::write(
        home.join(".zshrc"),
        format!(
            "# The next line updates PATH for the Google Cloud SDK.\n\
             if [ -f '{h}/google-cloud-sdk/path.zsh.inc' ]; then . '{h}/google-cloud-sdk/path.zsh.inc'; fi\n\n\
             # The next line enables shell command completion for gcloud.\n\
             if [ -f '{h}/google-cloud-sdk/completion.zsh.inc' ]; then . '{h}/google-cloud-sdk/completion.zsh.inc'; fi\n\
             test -e \"${{HOME}}/.iterm2_shell_integration.zsh\" && source \"${{HOME}}/.iterm2_shell_integration.zsh\"\n"
        ),
    )
    .unwrap();
    std::fs::create_dir_all(home.join("google-cloud-sdk")).unwrap();
    for name in [
        "google-cloud-sdk/path.zsh.inc",
        "google-cloud-sdk/completion.zsh.inc",
        ".iterm2_shell_integration.zsh",
    ] {
        std::fs::write(home.join(name), "# sourced\n").unwrap();
    }
    let profile = profile_with_checkouts(&home, None, &[]).unwrap();
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        denies_change(&profile, &home.join(".zshrc")),
        "precondition: .zshrc itself is write-denied"
    );
    let open: Vec<String> = [
        "google-cloud-sdk/path.zsh.inc",
        "google-cloud-sdk/completion.zsh.inc",
        ".iterm2_shell_integration.zsh",
    ]
    .iter()
    .map(|name| home.join(name))
    .filter(|path| !denies_change(&profile, path))
    .map(|path| path.display().to_string())
    .collect();
    assert!(
        open.is_empty(),
        "a login shell sources these, and an agent can write them: {open:?}"
    );
}

/// MED (fail closed, but every start): round 7 adds every session's `cwd` and `worktree_cwd` to every wrap, and each
/// worktree adds about 4.6 KB of deny lines even when the folder is gone (about twice that when it exists: its git dir
/// is locked too). The rows are never pruned, so a chat history with 200 worktree chats passes the 900,000-byte cap,
/// and from then on every agent, action, gate and check refuses to start while the sandbox is on. Ash ran about 90
/// worktrees at once on 10 Nov. Pass the profile by file, or lock only folders that exist and are git checkouts.
#[test]
fn two_hundred_worktree_chats_do_not_stop_every_sandboxed_start() {
    let root = scratch("sessions");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    {
        let conn = rusqlite::Connection::open(data.join("monocode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, worktree_cwd TEXT);",
        )
        .unwrap();
        let projects = serde_json::json!({ "projects": [
            { "id": "hub", "name": "Hub", "shortName": "Hub", "iconShape": "code", "folder": "/Users/test/Projects/hub" }
        ]});
        crate::local_hub::ensure_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO hub_local_docs (key, json, updated_at, rev) VALUES ('projects', ?1, 0, 1)",
            [projects.to_string()],
        )
        .unwrap();
        for n in 0..200 {
            conn.execute(
                "INSERT INTO sessions (id, cwd, worktree_cwd) VALUES (?1, '/Users/test/Projects/hub', ?2)",
                [
                    format!("s{n}"),
                    format!("/Users/test/Worktrees/hub-wp-{n}-agent-sandbox-round"),
                ],
            )
            .unwrap();
        }
    }
    let checkout = PathBuf::from("/Users/test/Worktrees/hub-wp-0-agent-sandbox-round");
    let folders = with_project_folders(Some(&data), std::slice::from_ref(&checkout)).unwrap();
    let built = profile_with_checkouts(Path::new("/Users/test"), Some(&data), &folders);
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        built.is_ok(),
        "a chat history with 200 worktree chats stops every sandboxed start: {:?}",
        built.err()
    );
}
