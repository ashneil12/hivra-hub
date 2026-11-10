//! WP-32's proofs: each reader maps sample entries, entries Hivra can't use are marked and never offered, and listing
//! never executes anything.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::readers::{exact_version, CLAUDE_REASON, DSH_REASON};
use super::*;

const COMMIT: &str = "6ea74587e384e1a8035c09ae33a46fe3f881eb9b";

fn fixture(name: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/plugins/discover/fixtures")
            .join(name),
    )
    .unwrap()
}

fn read(text: &str) -> Index {
    read_index(text, &Origin::Elsewhere, "macos").unwrap()
}

fn entry<'a>(index: &'a Index, name: &str) -> &'a Entry {
    index
        .entries
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("{name} not listed"))
}

fn no_fetch(url: &str) -> Result<Fetched, String> {
    panic!("nothing should be fetched, asked for {url}")
}

struct Tmp(PathBuf);
impl Tmp {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("hivra-discover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ----- Hivra's index ---------------------------------------------------------------------------------------------

#[test]
fn the_bundled_index_lists_the_five_default_plugins() {
    let index = read(BUNDLED_INDEX);
    assert_eq!(index.format, Format::Hivra);
    assert!(index.skipped.is_empty(), "{:?}", index.skipped);
    let names: Vec<&str> = index.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "pstack",
            "e2e-verify",
            "browser",
            "desktop-control",
            "council-personas"
        ]
    );

    let pstack = entry(&index, "pstack");
    assert_eq!(pstack.status, Status::Available);
    assert_eq!(pstack.license.as_deref(), Some("MIT"));
    assert_eq!(pstack.author.as_deref(), Some("Lauren Tan"));
    assert_eq!(pstack.version.as_deref(), Some("0.15.36"));
    assert_eq!(
        pstack.source,
        Some(InstallSource::Git {
            url: "https://github.com/cursor/plugins".into(),
            commit: COMMIT.into(),
            path: Some("pstack".into()),
        })
    );
    // The skill list matches the pstack copy WP-30 tests against.
    let skills = &pstack.adds[0];
    assert_eq!(skills.kind, "skills");
    assert_eq!(skills.count, Some(58));
    let browser = entry(&index, "browser");
    assert_eq!(browser.status, Status::Available);
    assert_eq!(browser.version.as_deref(), Some("1.0.0"));
    let raw: serde_json::Value = serde_json::from_str(BUNDLED_INDEX).unwrap();
    let pinned = &raw["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "browser")
        .unwrap()["versions"][0]["source"];
    assert_eq!(pinned["type"], "folder");
    assert_eq!(pinned["path"], "plugins/browser");
    assert!(
        pinned.get("commit").is_none(),
        "a commit of this repo is not the plugin source"
    );
    match &browser.source {
        Some(InstallSource::Local { path }) => {
            assert!(
                Path::new(path).ends_with(Path::new("plugins").join("browser")),
                "{path}"
            );
            assert!(std::path::Path::new(path).join("plugin.json").is_file());
        }
        other => panic!("the browser plugin is pinned to its folder, not {other:?}"),
    }
    let fixture_skills = std::fs::read_dir(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/fixtures/pstack/skills"),
    )
    .unwrap()
    .count();
    assert_eq!(fixture_skills, 58);

    // WP-42: Verify is the one offered plugin that can be installed. The pin is the npm package, unchanged.
    let verify = entry(&index, "e2e-verify");
    assert_eq!(verify.status, Status::Available);
    assert_eq!(verify.license.as_deref(), Some("Apache-2.0"));
    assert_eq!(
        verify.source,
        Some(InstallSource::Npm {
            package: "e2e".into(),
            version: "0.23.0".into(),
            registry: None,
        })
    );
    let skills = verify.adds.iter().find(|add| add.kind == "skills").unwrap();
    assert_eq!(skills.names, ["e2e", "when-to-verify"]);
    let servers = verify
        .adds
        .iter()
        .find(|add| add.kind == "mcpServers")
        .unwrap();
    assert_eq!(servers.names, ["e2e"]);

    for planned in ["desktop-control", "council-personas"] {
        let e = entry(&index, planned);
        assert_eq!(e.status, Status::Planned, "{planned}");
        assert!(
            e.source.is_none(),
            "{planned} must not carry an install source"
        );
        assert!(
            e.reason.as_deref().unwrap().contains("WP-"),
            "{planned}: {:?}",
            e.reason
        );
    }
}

#[test]
fn hivra_entries_validate_one_by_one() {
    let git = |commit: &str| json!({ "version": "1.0.0", "source": { "type": "git", "url": "https://github.com/a/b", "commit": commit } });
    let index = json!({
        "format": "hivra-plugin-index/1",
        "title": { "en": "Mine", "zh": "我的" },
        "plugins": [
            { "name": "good", "versions": [git(COMMIT), { "version": "1.10.0", "source": { "type": "npm", "package": "@me/good" } }, { "version": "1.2.0-rc.1", "source": { "type": "npm" } }],
              "contributes": { "skills": ["a", "b"], "mcpServers": 1, "crewRules": true, "panels": 0 }, "platforms": ["macos", "linux"] },
            { "name": "windows-only", "platforms": ["windows"], "versions": [git(COMMIT)] },
            { "name": "short-commit", "versions": [git("6ea7458")] },
            { "name": "floating", "versions": [{ "version": "^1.0.0", "source": { "type": "npm" } }] },
            { "name": "no-versions" },
            { "name": "Bad_Name", "versions": [git(COMMIT)] },
            { "name": "escapes", "versions": [{ "version": "1.0.0", "source": { "type": "git", "url": "https://github.com/a/b", "commit": COMMIT, "path": "../up" } }] },
            { "name": "plain-http", "versions": [{ "version": "1.0.0", "source": { "type": "git", "url": "http://github.com/a/b", "commit": COMMIT } }] },
            { "name": "odd-adds", "contributes": { "themes": 2 }, "versions": [git(COMMIT)] },
            { "name": "good", "versions": [git(COMMIT)] }
        ]
    });
    let index = read(&index.to_string());
    assert_eq!(index.title, "Mine");
    let names: Vec<&str> = index.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["good", "windows-only"]);

    let good = entry(&index, "good");
    // The newest exact version wins, whatever its order in the list.
    assert_eq!(good.version.as_deref(), Some("1.10.0"));
    assert_eq!(
        good.source,
        Some(InstallSource::Npm {
            package: "@me/good".into(),
            version: "1.10.0".into(),
            registry: None
        })
    );
    let kinds: Vec<(&str, Option<u32>)> = good
        .adds
        .iter()
        .map(|a| (a.kind.as_str(), a.count))
        .collect();
    assert_eq!(
        kinds,
        [
            ("skills", Some(2)),
            ("mcpServers", Some(1)),
            ("crewRules", None)
        ]
    );
    assert_eq!(good.status, Status::Available);

    let windows = entry(&index, "windows-only");
    assert_eq!(windows.status, Status::NotThisPlatform);
    assert_eq!(windows.reason.as_deref(), Some("Only for windows."));

    let skipped = index.skipped.join("\n");
    for expected in [
        "\"short-commit\" version 1.0.0 has a git source that isn't pinned to a full 40-character commit",
        "\"floating\" version 0 isn't an exact version",
        "\"no-versions\" has no versions to install",
        "\"Bad_Name\" has a name that may only use lowercase letters",
        "\"escapes\" version 1.0.0 has a git source whose path leaves the repository",
        "\"plain-http\" version 1.0.0 has a git source whose url isn't an https repository",
        "\"odd-adds\" says it adds \"themes\"",
        "\"good\" is listed twice",
    ] {
        assert!(skipped.contains(expected), "missing {expected:?} in:\n{skipped}");
    }
}

#[test]
fn broken_indexes_list_nothing_and_say_why() {
    for (text, says) in [
        ("not json", "isn't valid JSON"),
        ("[1, 2]", "isn't a JSON object"),
        (
            r#"{ "format": 2, "plugins": [] }"#,
            "format Hivra doesn't know",
        ),
        (r#"{ "plugins": [] }"#, "isn't a plugin index Hivra knows"),
        (
            r#"{ "format": "hivra-plugin-index/1", "plugins": [] }"#,
            "has no title",
        ),
    ] {
        let error = read_index(text, &Origin::Elsewhere, "macos").unwrap_err();
        assert!(error.contains(says), "{text}: {error}");
    }
}

#[test]
fn exact_versions_follow_semver() {
    for ok in [
        "0.0.0",
        "1.2.3",
        "1.0.0-rc.1",
        "1.0.0-alpha.beta.1+build.5",
        "10.20.30",
    ] {
        assert!(exact_version(ok), "{ok}");
    }
    for bad in [
        "1.2", "^1.2.3", "~1.2.3", "01.2.3", "1.2.3-01", "1.2.3-", "latest", "*", ">=1.0.0",
        "1.2.3 ",
    ] {
        assert!(!exact_version(bad), "{bad}");
    }
}

// ----- DeepSeek Harness format 1 ---------------------------------------------------------------------------------

#[test]
fn dsh_entries_map_and_are_marked_not_compatible() {
    let index = read(&fixture("dsh-index.json"));
    assert_eq!(index.format, Format::Dsh);
    assert_eq!(index.title, "Example Market");
    assert_eq!(index.description.as_deref(), Some("Community bundles"));
    assert_eq!(index.entries.len(), 2);
    assert!(
        index.skipped[0].contains("\"dsh-floating\""),
        "{:?}",
        index.skipped
    );

    let foo = entry(&index, "@scope/dsh-foo");
    assert_eq!(foo.title, "Foo");
    assert_eq!(foo.description, "Does foo");
    assert_eq!(foo.author.as_deref(), Some("Jane Doe"));
    assert_eq!(foo.category.as_deref(), Some("Productivity"));
    assert_eq!(foo.keywords, ["review"]);
    assert_eq!(
        foo.repository.as_deref(),
        Some("https://github.com/jane/dsh-plugins")
    );
    assert_eq!(foo.version.as_deref(), Some("1.10.0"));
    assert_eq!(
        foo.source,
        Some(InstallSource::Npm {
            package: "@scope/dsh-foo".into(),
            version: "1.10.0".into(),
            registry: None
        })
    );

    let bar = entry(&index, "dsh-bar");
    assert_eq!(
        bar.source,
        Some(InstallSource::Git {
            url: "https://gitlab.example/group/sub/repo".into(),
            commit: "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4".into(),
            path: Some("packages/bar".into()),
        })
    );
    for e in &index.entries {
        assert_eq!(e.status, Status::NotCompatible, "{}", e.name);
        assert_eq!(e.reason.as_deref(), Some(DSH_REASON));
        assert_eq!(e.format, Format::Dsh);
    }
}

// ----- Claude Code marketplaces ----------------------------------------------------------------------------------

#[test]
fn claude_marketplace_entries_map_their_portable_parts() {
    let origin = Origin::Repository {
        url: "https://github.com/acme/tools".into(),
        commit: COMMIT.into(),
    };
    let index = read_index(&fixture("claude-marketplace.json"), &origin, "macos").unwrap();
    assert_eq!(index.format, Format::ClaudeMarketplace);
    assert_eq!(index.title, "team-tools (Example Team)");
    assert_eq!(index.description.as_deref(), Some("Plugins our team uses"));
    assert!(
        index.skipped.iter().any(|s| s.contains("\"bad name!\"")),
        "{:?}",
        index.skipped
    );

    let reviewer = entry(&index, "reviewer");
    assert_eq!(reviewer.version.as_deref(), Some("2.1.0"));
    assert_eq!(reviewer.author.as_deref(), Some("Ada"));
    assert_eq!(reviewer.license.as_deref(), Some("MIT"));
    let adds: Vec<(&str, Vec<&str>)> = reviewer
        .adds
        .iter()
        .map(|a| {
            (
                a.kind.as_str(),
                a.names.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(
        adds,
        [
            ("skills", vec!["review", "summarise"]),
            ("mcpServers", vec!["github"])
        ]
    );
    assert_eq!(reviewer.left_out, ["slash commands", "hooks"]);
    // A relative source is a folder of the marketplace's repository, at the commit it was read at, under pluginRoot
    // only when it isn't written "./".
    assert_eq!(
        reviewer.source,
        Some(InstallSource::Git {
            url: "https://github.com/acme/tools".into(),
            commit: COMMIT.into(),
            path: Some("reviewer".into())
        })
    );
    assert_eq!(reviewer.status, Status::ListedOnly);
    assert_eq!(reviewer.reason.as_deref(), Some(CLAUDE_REASON));

    let formatter = entry(&index, "formatter");
    assert_eq!(formatter.status, Status::NotCompatible);
    assert!(formatter.reason.as_deref().unwrap().contains("only hooks"));
    assert_eq!(
        formatter.source,
        Some(InstallSource::Git {
            url: "https://github.com/acme/tools".into(),
            commit: COMMIT.into(),
            path: Some("plugins/formatter".into())
        })
    );

    let github = entry(&index, "from-github");
    assert_eq!(
        github.source,
        Some(InstallSource::Git {
            url: "https://github.com/acme/claude-skills".into(),
            commit: "0123456789abcdef0123456789abcdef01234567".into(),
            path: None,
        })
    );
    // "./skills" is one folder: the index doesn't say how many skills are in it.
    assert_eq!(github.adds[0].count, None);

    let floating = entry(&index, "floating");
    assert_eq!(floating.source, None);
    assert!(floating.reason.as_deref().unwrap().contains("isn't pinned"));

    assert_eq!(
        entry(&index, "from-npm").source,
        Some(InstallSource::Npm {
            package: "@acme/claude-plugin".into(),
            version: "1.4.2".into(),
            registry: None
        })
    );

    // Read without a known commit, relative sources aren't pinned.
    let unpinned = read(&fixture("claude-marketplace.json"));
    assert_eq!(entry(&unpinned, "reviewer").source, None);
}

#[test]
fn the_real_cursor_marketplace_reads() {
    // cursor/plugins' `.claude-plugin/marketplace.json` at 6ea74587, unchanged.
    let origin = Origin::Repository {
        url: "https://github.com/cursor/plugins".into(),
        commit: COMMIT.into(),
    };
    let index = read_index(&fixture("cursor-marketplace.json"), &origin, "linux").unwrap();
    assert_eq!(index.title, "cursor-plugins (Cursor)");
    let pstack = entry(&index, "pstack");
    assert_eq!(
        pstack.source,
        Some(InstallSource::Git {
            url: "https://github.com/cursor/plugins".into(),
            commit: COMMIT.into(),
            path: Some("harness/pstack/claude-code".into()),
        })
    );
    assert_eq!(pstack.status, Status::ListedOnly);
}

#[test]
fn nothing_but_the_hivra_index_is_ever_offered_for_install() {
    let origin = Origin::Repository {
        url: "https://github.com/acme/tools".into(),
        commit: COMMIT.into(),
    };
    for text in [
        fixture("dsh-index.json"),
        fixture("claude-marketplace.json"),
        fixture("cursor-marketplace.json"),
    ] {
        let index = read_index(&text, &origin, "macos").unwrap();
        assert!(
            index.entries.iter().all(|e| e.status != Status::Available),
            "{}",
            index.title
        );
    }
}

// ----- Sources ---------------------------------------------------------------------------------------------------

#[test]
fn sources_read_on_their_own_and_one_failure_spares_the_rest() {
    let tmp = Tmp::new();
    let file = tmp.0.join("dsh.json");
    std::fs::write(&file, fixture("dsh-index.json")).unwrap();
    let sources = vec![
        IndexSource::Bundled,
        IndexSource::File {
            path: file.to_string_lossy().into_owned(),
        },
        IndexSource::File {
            path: tmp.0.join("missing.json").to_string_lossy().into_owned(),
        },
        IndexSource::Url {
            url: "http://example.com/index.json".into(),
        },
        IndexSource::Github {
            repo: "not a repo".into(),
            git_ref: None,
        },
    ];
    let results = discover(&sources, &no_fetch);
    assert_eq!(results.len(), 5);
    assert_eq!(results[0].index.as_ref().unwrap().format, Format::Hivra);
    assert_eq!(results[1].index.as_ref().unwrap().format, Format::Dsh);
    assert!(results[2]
        .error
        .as_deref()
        .unwrap()
        .contains("Couldn't open"));
    assert!(results[3]
        .error
        .as_deref()
        .unwrap()
        .contains("must be an https address"));
    assert!(results[4]
        .error
        .as_deref()
        .unwrap()
        .contains("owner/repository"));
}

#[test]
fn a_github_marketplace_is_read_at_its_resolved_commit() {
    let asked = std::cell::RefCell::new(Vec::new());
    let fetch = |url: &str| -> Result<Fetched, String> {
        asked.borrow_mut().push(url.to_string());
        let text = if url.starts_with("https://api.github.com/") {
            json!({ "sha": COMMIT.to_uppercase() }).to_string()
        } else {
            fixture("cursor-marketplace.json")
        };
        Ok(Fetched {
            text,
            url: url.to_string(),
        })
    };
    let results = discover(
        &[IndexSource::Github {
            repo: "https://github.com/cursor/plugins.git".into(),
            git_ref: None,
        }],
        &fetch,
    );
    assert_eq!(
        *asked.borrow(),
        [
            "https://api.github.com/repos/cursor/plugins/commits/HEAD".to_string(),
            format!("https://raw.githubusercontent.com/cursor/plugins/{COMMIT}/.claude-plugin/marketplace.json"),
        ]
    );
    let index = results[0].index.as_ref().unwrap();
    assert!(
        matches!(&entry(index, "pstack").source, Some(InstallSource::Git { commit, .. }) if commit == COMMIT)
    );

    // A full commit needs no lookup; a ref with shell characters is refused before anything is fetched.
    asked.borrow_mut().clear();
    discover(
        &[IndexSource::Github {
            repo: "cursor/plugins".into(),
            git_ref: Some(COMMIT.into()),
        }],
        &fetch,
    );
    assert_eq!(asked.borrow().len(), 1);
    let refused = discover(
        &[IndexSource::Github {
            repo: "cursor/plugins".into(),
            git_ref: Some("main;rm -rf".into()),
        }],
        &no_fetch,
    );
    assert!(refused[0].error.is_some());
}

#[test]
fn a_raw_github_url_at_a_commit_pins_relative_sources() {
    let url = format!(
        "https://raw.githubusercontent.com/cursor/plugins/{COMMIT}/.claude-plugin/marketplace.json"
    );
    let fetch = |u: &str| {
        Ok(Fetched {
            text: fixture("cursor-marketplace.json"),
            url: u.to_string(),
        })
    };
    let results = discover(&[IndexSource::Url { url: url.clone() }], &fetch);
    assert!(entry(results[0].index.as_ref().unwrap(), "pstack")
        .source
        .is_some());
    assert_eq!(
        raw_github_origin("https://raw.githubusercontent.com/cursor/plugins/main/x.json"),
        None
    );
}

#[test]
fn an_index_over_the_size_limit_is_refused() {
    let tmp = Tmp::new();
    let file = tmp.0.join("big.json");
    std::fs::write(&file, vec![b' '; (MAX_INDEX_BYTES + 1) as usize]).unwrap();
    let results = discover(
        &[IndexSource::File {
            path: file.to_string_lossy().into_owned(),
        }],
        &no_fetch,
    );
    assert!(results[0]
        .error
        .as_deref()
        .unwrap()
        .contains("larger than 4 MB"));
}

#[test]
fn sources_round_trip_as_the_settings_list_stores_them() {
    let sources: Vec<IndexSource> = serde_json::from_value(json!([
        { "kind": "bundled" },
        { "kind": "url", "url": "https://example.com/index.json" },
        { "kind": "github", "repo": "cursor/plugins", "ref": "main" },
        { "kind": "file", "path": "~/index.json" }
    ]))
    .unwrap();
    assert_eq!(
        sources[2],
        IndexSource::Github {
            repo: "cursor/plugins".into(),
            git_ref: Some("main".into())
        }
    );
    let back = serde_json::to_value(&sources).unwrap();
    assert_eq!(
        back[2],
        json!({ "kind": "github", "repo": "cursor/plugins", "ref": "main" })
    );
}

// ----- Listing never executes anything ---------------------------------------------------------------------------

fn tree(root: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for item in std::fs::read_dir(&dir).unwrap() {
            let item = item.unwrap();
            let meta = item.metadata().unwrap();
            if meta.is_dir() {
                stack.push(item.path());
            }
            out.push((item.path().to_string_lossy().into_owned(), meta.len()));
        }
    }
    out.sort();
    out
}

#[test]
fn listing_never_executes_anything() {
    // 1. Structure: nothing in this module can start a process, load a plugin or install one.
    for (file, source) in [
        ("mod.rs", include_str!("mod.rs")),
        ("readers.rs", include_str!("readers.rs")),
    ] {
        let code: String = source
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for banned in [
            "std::process",
            "Command::new",
            "process::Command",
            "load_plugin",
            "install_local",
            "registry::",
            "plugin-mcp",
            "tauri::api::shell",
            "spawn(",
        ] {
            assert!(!code.contains(banned), "{file} uses {banned}");
        }
    }

    // 2. Behaviour: an index whose plugins sit right beside it, each with an MCP server and an install script that
    // would leave a marker, lists them and leaves the folder exactly as it was.
    let tmp = Tmp::new();
    let marker = tmp.0.join("ran");
    for name in ["one", "two"] {
        let dir = tmp.0.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("plugin.json"),
            json!({ "$schema": crate::plugins::manifest::PLUGIN_SCHEMA_1_0_0, "name": name })
                .to_string(),
        )
        .unwrap();
        let touch =
            json!({ "command": "sh", "args": ["-c", format!("touch {}", marker.display())] });
        std::fs::write(dir.join("mcp.json"), json!({ "$schema": crate::plugins::mcp::MCP_SCHEMA_1_0_0, "mcpServers": { "s": touch } }).to_string()).unwrap();
        std::fs::write(dir.join("package.json"), json!({ "name": name, "scripts": { "postinstall": format!("touch {}", marker.display()) } }).to_string()).unwrap();
    }
    let index = json!({
        "format": "hivra-plugin-index/1",
        "title": "Beside",
        "plugins": [
            { "name": "one", "versions": [{ "version": "1.0.0", "source": { "type": "git", "url": "https://github.com/a/one", "commit": COMMIT } }], "contributes": { "mcpServers": ["s"] } },
            { "name": "two", "versions": [{ "version": "1.0.0", "source": { "type": "npm" } }] }
        ]
    });
    let file = tmp.0.join("index.json");
    std::fs::write(&file, index.to_string()).unwrap();
    let before = tree(&tmp.0);
    let results = discover(
        &[
            IndexSource::File {
                path: file.to_string_lossy().into_owned(),
            },
            IndexSource::Bundled,
        ],
        &no_fetch,
    );
    assert_eq!(results[0].index.as_ref().unwrap().entries.len(), 2);
    assert_eq!(tree(&tmp.0), before);
    assert!(!marker.exists());
}
