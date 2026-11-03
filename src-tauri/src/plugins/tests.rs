//! WP-30's proofs: pstack loads, broken parts are skipped while the rest loads, every extension type validates, and
//! enable / disable / uninstall leave the file system and the registry exactly as they were.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::fsutil;
use super::hivra::{self, PANEL_BLOCK_KINDS, PANEL_PERMISSIONS};
use super::manifest::{load_plugin, plugin_name_problem, PLUGIN_SCHEMA_1_0_0};
use super::mcp::{expand, launch_plan, Transport, MCP_SCHEMA_1_0_0};
use super::registry::{self, Contribution, Host, Scope, Source};
use super::wiring::{self, native_name};

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("hivra-plugins-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir.canonicalize().unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn manifest(name: &str) -> String {
    json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": name, "version": "1.0.0" }).to_string()
}

fn skill(root: &Path, folder: &str, name: &str, description: &str) {
    write(
        &root.join("skills").join(folder).join("SKILL.md"),
        &format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"),
    );
}

fn pstack() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/fixtures/pstack")
}

fn reports_for<'a>(reports: &'a [super::Report], path: &str) -> Vec<&'a str> {
    reports
        .iter()
        .filter(|r| r.path == path)
        .map(|r| r.message.as_str())
        .collect()
}

// ---- the Agent Plugins core -------------------------------------------------------------------------------------

#[test]
fn pstack_real_manifest_and_skills_load() {
    let loaded = load_plugin(&pstack()).expect("pstack loads");
    assert_eq!(loaded.manifest.name, "pstack");
    assert_eq!(loaded.manifest.version.as_deref(), Some("0.15.36"));
    assert_eq!(loaded.manifest.license.as_deref(), Some("MIT"));
    assert_eq!(
        loaded
            .manifest
            .author
            .as_ref()
            .and_then(|a| a.name.as_deref()),
        Some("Lauren Tan")
    );
    assert!(loaded.manifest.keywords.contains(&"pstack".to_string()));
    assert_eq!(loaded.skills.len(), 58, "every pstack skill loads");
    for name in [
        "tdd",
        "unslop",
        "why",
        "principle-prove-it-works",
        "create-verification-skill",
    ] {
        let skill = loaded
            .skills
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("{name}"));
        assert_eq!(skill.dir, format!("skills/{name}"));
        assert!(!skill.description.is_empty());
    }
    assert!(loaded.mcp_servers.is_empty());
    assert!(loaded.hivra.is_empty());
    // agents/ is Cursor's own folder: not a component type, ignored without a report.
    assert!(loaded.reports.is_empty(), "{:?}", loaded.reports);
}

#[test]
fn a_broken_skill_is_skipped_and_the_rest_load() {
    let tmp = Tmp::new("broken-skill");
    let root = tmp.path();
    write(&root.join("plugin.json"), &manifest("demo"));
    skill(root, "good", "good", "Works.");
    skill(root, "other", "other", "Also works.");
    skill(
        root,
        "renamed",
        "something-else",
        "Name doesn't match its folder.",
    );
    skill(root, "Bad_Name", "Bad_Name", "Uppercase isn't allowed.");
    skill(root, "no-description", "no-description", "");
    write(&root.join("skills/no-front/SKILL.md"), "# no frontmatter\n");
    write(
        &root.join("skills/nested/deeper/SKILL.md"),
        "---\nname: deeper\ndescription: x\n---\n",
    );
    write(&root.join("skills/README.md"), "not a skill folder");

    let loaded = load_plugin(root).unwrap();
    let names: Vec<_> = loaded.skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["good", "other"]);
    assert_eq!(reports_for(&loaded.reports, "skills/renamed").len(), 1);
    assert_eq!(reports_for(&loaded.reports, "skills/Bad_Name").len(), 1);
    assert!(reports_for(&loaded.reports, "skills/no-description")[0].contains("description"));
    assert!(reports_for(&loaded.reports, "skills/no-front")[0].contains("frontmatter"));
    // Discovery is not recursive: skills/nested has no SKILL.md of its own and is simply not a skill.
    assert!(reports_for(&loaded.reports, "skills/nested").is_empty());
}

#[test]
fn manifest_rules_follow_the_standard() {
    let tmp = Tmp::new("manifest");
    let root = tmp.path();
    let load = |value: serde_json::Value| {
        write(&root.join("plugin.json"), &value.to_string());
        load_plugin(root)
    };
    // Unknown top-level fields and a non-object `extensions` are reported, not fatal.
    let loaded =
        load(json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": "ok", "hooks": {}, "extensions": 3 }))
            .unwrap();
    assert_eq!(loaded.reports.len(), 2, "{:?}", loaded.reports);
    // Unknown namespaces are kept for their clients, unvalidated; Hivra's own must be an object.
    let loaded = load(json!({
        "$schema": PLUGIN_SCHEMA_1_0_0, "name": "ok",
        "extensions": { "com.example.client": { "x": 1 }, "org.other": "anything", "hivra": [] }
    }))
    .unwrap();
    assert!(loaded
        .manifest
        .extensions
        .contains_key("com.example.client"));
    assert_eq!(loaded.reports.len(), 1);
    // Everything else is fatal.
    for bad in [
        json!({ "name": "no-schema" }),
        json!({ "$schema": "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json", "name": "future" }),
        json!({ "$schema": PLUGIN_SCHEMA_1_0_0 }),
        json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": "My-Plugin" }),
        json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": "ok", "version": 1 }),
        json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": "ok", "author": { "name": "x", "twitter": "y" } }),
        json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": "ok", "keywords": ["a", 2] }),
        json!([]),
    ] {
        assert!(load(bad.clone()).is_err(), "{bad} should be rejected");
    }
    std::fs::remove_file(root.join("plugin.json")).unwrap();
    assert!(load_plugin(root).is_err());
}

#[test]
fn plugin_names_follow_section_5_5() {
    for good in ["my-plugin", "acme.tools", "lint3r", "a"] {
        assert_eq!(plugin_name_problem(good), None, "{good}");
    }
    for bad in [
        "My-Plugin",
        "-start",
        "has--double",
        "too.many..dots",
        "",
        "end-",
        &"a".repeat(65),
    ] {
        assert!(plugin_name_problem(bad).is_some(), "{bad}");
    }
}

fn mcp(root: &Path, servers: serde_json::Value) {
    write(
        &root.join("mcp.json"),
        &json!({ "$schema": MCP_SCHEMA_1_0_0, "mcpServers": servers }).to_string(),
    );
}

#[test]
fn mcp_servers_validate_one_by_one() {
    let tmp = Tmp::new("mcp");
    let root = tmp.path();
    write(&root.join("plugin.json"), &manifest("servers"));
    skill(root, "kept", "kept", "Still loads when mcp.json is broken.");
    write(&root.join("bin/server"), "#!/bin/sh\n");
    mcp(
        root,
        json!({
            "local": { "type": "stdio", "command": "./bin/server", "args": ["--data", "${PLUGIN_DATA}/x"], "env": { "A": "${PLUGIN_ROOT}" }, "cwd": "${PLUGIN_ROOT}" },
            "bare": { "type": "stdio", "command": "npx" },
            "remote": { "type": "streamable-http", "url": "https://example.com/mcp", "headers": { "X-Tenant": "public" } },
            "legacy": { "type": "sse", "url": "http://127.0.0.1:9000/sse" },
            "shell": { "type": "stdio", "command": "node server.js" },
            "escape": { "type": "stdio", "command": "../bin/server" },
            "bad-cwd": { "type": "stdio", "command": "npx", "cwd": "data" },
            "climb": { "type": "stdio", "command": "npx", "cwd": "${PLUGIN_DATA}/../../etc" },
            "reserved": { "type": "stdio", "command": "npx", "env": { "PLUGIN_ROOT": "/" } },
            "mixed": { "type": "stdio", "command": "npx", "url": "https://example.com" },
            "plain-http": { "type": "streamable-http", "url": "http://example.com/mcp" },
            "user-info": { "type": "streamable-http", "url": "https://me:pw@example.com/mcp" },
            "dup-header": { "type": "streamable-http", "url": "https://example.com", "headers": { "X-A": "1", "x-a": "2" } },
            "websocket": { "type": "ws", "url": "wss://example.com" }
        }),
    );
    let loaded = load_plugin(root).unwrap();
    let mut names: Vec<_> = loaded.mcp_servers.iter().map(|s| s.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["bare", "legacy", "local", "remote"]);
    assert_eq!(loaded.reports.len(), 10, "{:#?}", loaded.reports);
    assert_eq!(loaded.skills.len(), 1);

    // A broken file disables MCP only.
    for broken in [
        "{not json".to_string(),
        json!({ "$schema": "https://agent-plugins.org/schemas/9.9.9/mcp.schema.json", "mcpServers": {} }).to_string(),
        json!({ "$schema": MCP_SCHEMA_1_0_0, "mcpServers": {}, "extra": true }).to_string(),
        json!({ "mcpServers": {} }).to_string(),
    ] {
        write(&root.join("mcp.json"), &broken);
        let loaded = load_plugin(root).unwrap();
        assert!(loaded.mcp_servers.is_empty());
        assert_eq!(loaded.skills.len(), 1);
        assert_eq!(reports_for(&loaded.reports, "mcp.json").len(), 1, "{broken}");
    }
}

#[test]
fn placeholders_expand_once_and_only_the_two_known_ones() {
    let root = Path::new("/p/${PLUGIN_DATA}");
    let data = Path::new("/d");
    assert_eq!(
        expand("${PLUGIN_ROOT}/x", root, data),
        "/p/${PLUGIN_DATA}/x"
    );
    assert_eq!(
        expand("${PLUGIN_DATA}:${HOME}:${PLUGIN_", root, data),
        "/d:${HOME}:${PLUGIN_"
    );
}

#[test]
fn a_stdio_server_starts_in_the_plugin_with_its_variables() {
    let tmp = Tmp::new("launch");
    let root = tmp.path().join("plugin");
    let data = tmp.path().join("data");
    std::fs::create_dir_all(data.join("work")).unwrap();
    write(&root.join("plugin.json"), &manifest("launch"));
    write(&root.join("bin/server"), "#!/bin/sh\n");
    mcp(
        &root,
        json!({
            "default": { "type": "stdio", "command": "./bin/server", "args": ["${PLUGIN_ROOT}/a"], "env": { "D": "${PLUGIN_DATA}/db" } },
            "in-data": { "type": "stdio", "command": "tool", "cwd": "${PLUGIN_DATA}/work" }
        }),
    );
    let loaded = load_plugin(&root).unwrap();
    let root = loaded.root.clone();
    let server = |name: &str| {
        loaded
            .mcp_servers
            .iter()
            .find(|s| s.name == name)
            .unwrap()
            .clone()
    };
    let plan = launch_plan(&root, &data, &server("default")).unwrap();
    assert_eq!(plan.program, root.join("bin/server"));
    assert_eq!(plan.cwd, root);
    assert_eq!(plan.args, [format!("{}/a", root.display())]);
    assert!(plan
        .env
        .contains(&("D".into(), format!("{}/db", data.display()))));
    assert_eq!(
        &plan.env[plan.env.len() - 2..],
        &[
            ("PLUGIN_ROOT".to_string(), root.display().to_string()),
            ("PLUGIN_DATA".to_string(), data.display().to_string()),
        ]
    );
    let plan = launch_plan(&root, &data, &server("in-data")).unwrap();
    assert_eq!(plan.program, PathBuf::from("tool"));
    assert_eq!(plan.cwd, data.join("work").canonicalize().unwrap());
}

#[cfg(unix)]
#[test]
fn paths_that_leave_the_plugin_are_refused() {
    let tmp = Tmp::new("containment");
    let root = tmp.path().join("plugin");
    let outside = tmp.path().join("outside");
    write(
        &outside.join("SKILL.md"),
        "---\nname: stolen\ndescription: x\n---\n",
    );
    write(&root.join("plugin.json"), &manifest("contained"));
    skill(&root, "inside", "inside", "Fine.");
    std::fs::create_dir_all(root.join("skills/stolen")).unwrap();
    std::os::unix::fs::symlink(
        outside.join("SKILL.md"),
        root.join("skills/stolen/SKILL.md"),
    )
    .unwrap();
    std::os::unix::fs::symlink(&outside, root.join("skills/linked")).unwrap();
    let loaded = load_plugin(&root).unwrap();
    assert_eq!(
        loaded
            .skills
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["inside"]
    );
    assert_eq!(loaded.reports.len(), 2, "{:?}", loaded.reports);

    // plugin.json itself outside: the plugin is rejected.
    let other = tmp.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(root.join("plugin.json"), other.join("plugin.json")).unwrap();
    assert!(load_plugin(&other).is_err());
}

// ---- Hivra's extension folder -----------------------------------------------------------------------------------

fn hivra_plugin(root: &Path) {
    let ns = root.join(hivra::NAMESPACE);
    write(&root.join("plugin.json"), &manifest("extras"));
    // panels
    write(
        &ns.join("panels/board/panel.json"),
        &json!({ "kind": "blocks", "title": "Board", "blocks": [{ "kind": "note", "title": "Hi", "text": "x" }] }).to_string(),
    );
    write(
        &ns.join("panels/custom/panel.json"),
        &json!({ "kind": "bespoke", "title": "Custom", "permissions": ["agents.read", "tasks.read"] }).to_string(),
    );
    write(&ns.join("panels/custom/index.html"), "<p>hi</p>");
    write(
        &ns.join("panels/keys/panel.json"),
        &json!({ "kind": "bespoke", "title": "Keys", "permissions": ["keys.read"] }).to_string(),
    );
    write(&ns.join("panels/keys/index.html"), "<p>no</p>");
    write(
        &ns.join("panels/no-html/panel.json"),
        &json!({ "kind": "bespoke", "title": "No HTML", "permissions": [] }).to_string(),
    );
    write(
        &ns.join("panels/weird/panel.json"),
        &json!({ "kind": "blocks", "title": "W", "blocks": [{ "kind": "video", "title": "v" }] })
            .to_string(),
    );
    // personas
    write(
        &ns.join("personas/council-ada.md"),
        "---\nname: council-ada\ndescription: \"Formal systems.\"\nmodel: sonnet\ncouncil:\n  figure: Ada Lovelace\n---\n\n## Identity\n\nYou are Ada.\n",
    );
    write(
        &ns.join("personas/wrong-name.md"),
        "---\nname: someone\ndescription: x\n---\nText\n",
    );
    write(
        &ns.join("personas/empty.md"),
        "---\nname: empty\ndescription: x\n---\n\n",
    );
    write(&ns.join("personas/notes.txt"), "not a persona");
    // monos
    write(
        &ns.join("monos/designer/SOUL.md"),
        "# Designer\n\nCares about the UI.\n",
    );
    write(
        &ns.join("monos/designer/mono.json"),
        &json!({
            "name": "Designer", "role": "UI and design", "skills": ["unslop"],
            "crewRules": [{ "match": { "labels": ["ui"] }, "cli": "claude", "effort": "high" }],
            "habits": [{ "title": "Weekly look", "schedule": "every monday 9:00", "prompt": "Review the UI." }]
        })
        .to_string(),
    );
    write(
        &ns.join("monos/soulless/mono.json"),
        &json!({ "name": "No soul" }).to_string(),
    );
    write(&ns.join("monos/bad-skill/SOUL.md"), "soul");
    write(
        &ns.join("monos/bad-skill/mono.json"),
        &json!({ "name": "B", "skills": ["Not A Skill"] }).to_string(),
    );
    // crew rules
    write(
        &ns.join("crew-rules.json"),
        &json!({ "rules": [
            { "match": { "labels": ["docs"] }, "cli": "codex", "model": "gpt-5" },
            { "match": { "paths": ["src/ui/**"] }, "effort": "max" },
            { "match": {}, "cli": "claude" },
            { "match": { "labels": ["x"] }, "cli": "notepad" },
            { "match": { "labels": ["x"] } },
            { "match": { "labels": ["x"] }, "effort": "huge" }
        ] })
        .to_string(),
    );
    // commands
    write(
        &ns.join("commands/review.md"),
        "---\ndescription: Review the diff\n---\nReview the current diff for bugs.\n",
    );
    write(&ns.join("commands/plain.md"), "Just a prompt.\n");
    write(
        &ns.join("commands/empty.md"),
        "---\ndescription: nothing\n---\n",
    );
    write(&ns.join("commands/Bad Name.md"), "x");
    // something Hivra doesn't know
    write(&ns.join("hooks/hooks.json"), "{}");
}

#[test]
fn each_hivra_extension_type_validates() {
    let tmp = Tmp::new("hivra");
    let root = tmp.path();
    hivra_plugin(root);
    let loaded = load_plugin(root).unwrap();
    let h = &loaded.hivra;
    let ids = |v: Vec<&str>| v.join(",");
    assert_eq!(
        ids(h.panels.iter().map(|p| p.id.as_str()).collect()),
        "board,custom"
    );
    assert_eq!(h.panels[1].permissions, ["agents.read", "tasks.read"]);
    assert_eq!(h.panels[1].dir, "hivra/panels/custom");
    assert_eq!(
        ids(h.personas.iter().map(|p| p.id.as_str()).collect()),
        "council-ada"
    );
    assert_eq!(h.personas[0].description, "Formal systems.");
    assert_eq!(
        ids(h.monos.iter().map(|m| m.id.as_str()).collect()),
        "designer"
    );
    assert_eq!(h.monos[0].crew_rules[0].cli.as_deref(), Some("claude"));
    assert_eq!(h.crew_rules.len(), 2);
    assert_eq!(h.crew_rules[0].model.as_deref(), Some("gpt-5"));
    assert_eq!(
        ids(h.commands.iter().map(|c| c.name.as_str()).collect()),
        "plain,review"
    );
    assert_eq!(h.commands[1].description, "Review the diff");

    let count = |prefix: &str| {
        loaded
            .reports
            .iter()
            .filter(|r| r.path.starts_with(prefix))
            .count()
    };
    assert_eq!(count("hivra/panels/"), 3, "{:#?}", loaded.reports);
    assert_eq!(count("hivra/personas/"), 2);
    assert_eq!(count("hivra/monos/"), 2);
    assert_eq!(count("hivra/crew-rules.json"), 4);
    assert_eq!(count("hivra/commands/"), 2);
    assert_eq!(count("hivra/hooks"), 1);
}

/// The panel permission and block lists are copies of pageSpec.ts's; they must not drift.
#[test]
fn panel_lists_match_the_pages_spec() {
    let source = include_str!("../../../src/features/pages/model/pageSpec.ts");
    let quoted = |line_start: &str| -> Vec<String> {
        let line = source
            .lines()
            .find(|l| l.starts_with(line_start))
            .unwrap_or_else(|| panic!("{line_start}"));
        line.split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    };
    let mut caps = Vec::new();
    for list in [
        "export const LIVE_READS",
        "export const HUB_READS",
        "export const PAGE_ACTIONS",
        "export const WRITES",
    ] {
        caps.extend(quoted(list));
    }
    let mut ours: Vec<String> = PANEL_PERMISSIONS.iter().map(|s| s.to_string()).collect();
    caps.sort();
    ours.sort();
    assert_eq!(ours, caps);
    assert_eq!(quoted("export const BLOCK_KINDS"), PANEL_BLOCK_KINDS);
}

// ---- the registry -----------------------------------------------------------------------------------------------

fn host(tmp: &Tmp) -> Host {
    let host = Host {
        root: tmp.path().join("app-data/plugins"),
        agents_skills: tmp.path().join("home/.agents/skills"),
    };
    std::fs::create_dir_all(&host.root).unwrap();
    std::fs::create_dir_all(tmp.path().join("home")).unwrap();
    host
}

/// A plugin with two skills, a stdio and a remote server, and a Hivra panel.
fn full_plugin(root: &Path, name: &str) {
    write(&root.join("plugin.json"), &manifest(name));
    skill(root, "alpha", "alpha", "First.");
    skill(root, "beta", "beta", "Second.");
    write(&root.join("bin/server"), "#!/bin/sh\necho hi\n");
    mcp(
        root,
        json!({
            "tools": { "type": "stdio", "command": "./bin/server", "cwd": "${PLUGIN_DATA}" },
            "web": { "type": "streamable-http", "url": "https://example.com/mcp" },
            "old": { "type": "sse", "url": "https://example.com/sse" }
        }),
    );
    write(
        &root.join("hivra/panels/board/panel.json"),
        &json!({ "kind": "blocks", "title": "Board", "blocks": [{ "kind": "note", "title": "Hi", "text": "x" }] }).to_string(),
    );
}

#[test]
fn install_enable_disable_uninstall_leave_no_trace() {
    let tmp = Tmp::new("registry");
    let host = host(&tmp);
    let source = tmp.path().join("src/demo");
    full_plugin(&source, "demo");
    let project = tmp.path().join("work/project");
    std::fs::create_dir_all(&project).unwrap();
    let watched = [host.root.as_path(), &tmp.path().join("home")];
    let before = fsutil::tree(&watched);

    let installed = registry::install_local(&host, &source, Source::local(&source)).unwrap();
    let entry = installed.entry.unwrap();
    assert_eq!(entry.version.as_deref(), Some("1.0.0"));
    assert!(!entry.enabled.any());
    assert!(host.installed("demo").join("plugin.json").is_file());
    assert!(host.data("demo").is_dir());
    assert!(
        registry::install_local(&host, &source, Source::local(&source)).is_err(),
        "no second copy"
    );

    // On for one project: Claude's shim and the records, no user-wide links.
    let on = registry::enable(
        &host,
        "demo",
        &Scope::Project(project.display().to_string()),
    )
    .unwrap();
    let entry = on.entry.unwrap();
    assert!(host
        .claude_shim("demo")
        .join(".claude-plugin/plugin.json")
        .is_file());
    assert!(host
        .claude_shim("demo")
        .join("skills/alpha/SKILL.md")
        .is_file());
    assert!(!host.agents_skills.exists());
    let kinds: Vec<_> = entry
        .contributions
        .iter()
        .map(|c| serde_json::to_value(c).unwrap()["kind"].clone())
        .collect();
    assert_eq!(
        kinds,
        [
            "files",
            "data",
            "claude-shim",
            "skill",
            "skill",
            "mcp-server",
            "mcp-server",
            "mcp-server",
            "panel"
        ]
    );

    // On everywhere too: each skill is linked where Codex and the other `.agents` readers look.
    registry::enable(&host, "demo", &Scope::Global).unwrap();
    assert!(host.agents_skills.join("alpha/SKILL.md").is_file());
    assert_eq!(
        fsutil::link_target(&host.agents_skills.join("beta")),
        Some(host.installed("demo").join("skills/beta"))
    );

    // Off everywhere: the links go; still on for the project, so the shim stays.
    registry::disable(&host, "demo", &Scope::Global).unwrap();
    assert!(
        !host.agents_skills.exists(),
        "the skills folder it made is gone again"
    );
    assert!(host.claude_shim("demo").is_dir());

    // Off for the project too: everything but the installed files goes.
    let off = registry::disable(
        &host,
        "demo",
        &Scope::Project(project.display().to_string()),
    )
    .unwrap();
    assert_eq!(off.entry.unwrap().contributions.len(), 2);
    assert!(!host.claude_shim("demo").exists());

    registry::enable(&host, "demo", &Scope::Global).unwrap();
    registry::uninstall(&host, "demo").unwrap();
    assert_eq!(fsutil::tree(&watched), before, "nothing left behind");
    assert!(registry::read(&host).unwrap().plugins.is_empty());
    // The source folder was only read.
    assert!(source.join("skills/alpha/SKILL.md").is_file());
}

#[test]
fn links_it_did_not_make_are_never_replaced_or_removed() {
    let tmp = Tmp::new("clash");
    let host = host(&tmp);
    let theirs = tmp.path().join("theirs/alpha");
    write(
        &theirs.join("SKILL.md"),
        "---\nname: alpha\ndescription: Mine.\n---\n",
    );
    std::fs::create_dir_all(&host.agents_skills).unwrap();
    fsutil::link_dir(&theirs, &host.agents_skills.join("alpha")).unwrap();
    let source = tmp.path().join("src/demo");
    full_plugin(&source, "demo");
    let watched = [host.root.as_path(), &tmp.path().join("home")];
    let before = fsutil::tree(&watched);

    registry::install_local(&host, &source, Source::local(&source)).unwrap();
    let on = registry::enable(&host, "demo", &Scope::Global).unwrap();
    assert!(on
        .reports
        .iter()
        .any(|r| r.message.contains("already has a skill called \"alpha\"")));
    assert_eq!(
        fsutil::link_target(&host.agents_skills.join("alpha")),
        Some(theirs.clone())
    );
    assert!(host.agents_skills.join("beta").exists());

    // Someone re-points our beta link: disabling leaves it alone.
    let elsewhere = tmp.path().join("elsewhere/beta");
    std::fs::create_dir_all(&elsewhere).unwrap();
    fsutil::remove_tree(&host.agents_skills.join("beta")).unwrap();
    fsutil::link_dir(&elsewhere, &host.agents_skills.join("beta")).unwrap();
    registry::uninstall(&host, "demo").unwrap();
    assert_eq!(
        fsutil::link_target(&host.agents_skills.join("alpha")),
        Some(theirs)
    );
    assert_eq!(
        fsutil::link_target(&host.agents_skills.join("beta")),
        Some(elsewhere)
    );
    fsutil::remove_tree(&host.agents_skills.join("beta")).unwrap();
    assert_eq!(fsutil::tree(&watched), before);
}

#[test]
fn a_plugin_that_does_not_load_installs_nothing() {
    let tmp = Tmp::new("refused");
    let host = host(&tmp);
    let source = tmp.path().join("src/bad");
    write(
        &source.join("plugin.json"),
        &json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": "Bad Name" }).to_string(),
    );
    let before = fsutil::tree(&[host.root.as_path()]);
    assert!(registry::install_local(&host, &source, Source::local(&source)).is_err());
    assert_eq!(fsutil::tree(&[host.root.as_path()]), before);
}

#[test]
fn installing_pstack_registers_every_skill() {
    let tmp = Tmp::new("pstack");
    let host = host(&tmp);
    registry::install_local(&host, &pstack(), Source::local(&pstack())).unwrap();
    let entry = registry::enable(&host, "pstack", &Scope::Global)
        .unwrap()
        .entry
        .unwrap();
    let skills = entry
        .contributions
        .iter()
        .filter(|c| matches!(c, Contribution::Skill { .. }))
        .count();
    let links = entry
        .contributions
        .iter()
        .filter(|c| matches!(c, Contribution::SkillLink { .. }))
        .count();
    assert_eq!((skills, links), (58, 58));
    assert!(host.agents_skills.join("tdd/SKILL.md").is_file());
    registry::uninstall(&host, "pstack").unwrap();
    assert!(!host.agents_skills.exists());
}

// ---- wiring -----------------------------------------------------------------------------------------------------

#[test]
fn sessions_get_skills_and_servers_where_the_plugin_is_on() {
    let tmp = Tmp::new("wiring");
    let host = host(&tmp);
    let source = tmp.path().join("src/demo");
    full_plugin(&source, "demo");
    let project = tmp.path().join("work/project");
    let elsewhere = tmp.path().join("work/other");
    std::fs::create_dir_all(project.join("sub")).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    registry::install_local(&host, &source, Source::local(&source)).unwrap();
    let cli = "/Applications/Hivra.app/Contents/MacOS/monocode";

    // Installed but off: nothing.
    let none = wiring::session_wiring(&host, Some(&project), Some(cli)).unwrap();
    assert!(none.claude_plugin_dirs.is_empty() && none.claude_mcp_servers.is_empty());

    registry::enable(
        &host,
        "demo",
        &Scope::Project(project.display().to_string()),
    )
    .unwrap();
    let wired = wiring::session_wiring(&host, Some(&project.join("sub")), Some(cli)).unwrap();
    assert_eq!(
        wired.claude_plugin_dirs,
        [host.claude_shim("demo").display().to_string()]
    );
    let tools = &wired.claude_mcp_servers["demo-tools"];
    assert_eq!(tools["command"], cli);
    let args: Vec<&str> = tools["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    assert_eq!(&args[..1], ["plugin-mcp"]);
    assert!(args.windows(2).any(|w| w == ["--plugin", "demo"]));
    assert!(args.windows(2).any(|w| w[0] == "--project"));
    assert_eq!(
        wired.claude_mcp_servers["demo-web"],
        json!({ "type": "http", "url": "https://example.com/mcp", "headers": {} })
    );
    assert_eq!(wired.claude_mcp_servers["demo-old"]["type"], "sse");
    assert_eq!(wired.codex_mcp_servers["demo-tools"], *tools);
    assert_eq!(
        wired.codex_mcp_servers["demo-web"],
        json!({ "url": "https://example.com/mcp", "http_headers": {} })
    );
    assert!(!wired.codex_mcp_servers.contains_key("demo-old"));
    assert_eq!(wired.reports.len(), 1, "Codex can't take the SSE server");

    // Another folder: nothing until it is on everywhere.
    assert!(wiring::session_wiring(&host, Some(&elsewhere), Some(cli))
        .unwrap()
        .claude_plugin_dirs
        .is_empty());
    registry::enable(&host, "demo", &Scope::Global).unwrap();
    let global = wiring::session_wiring(&host, Some(&elsewhere), Some(cli)).unwrap();
    assert_eq!(global.claude_plugin_dirs.len(), 1);
    assert!(!global.claude_mcp_servers["demo-tools"]["args"]
        .to_string()
        .contains("--project"));
    // Without the app's launcher, stdio servers wait; remote ones still go.
    let no_cli = wiring::session_wiring(&host, Some(&elsewhere), None).unwrap();
    assert!(!no_cli.claude_mcp_servers.contains_key("demo-tools"));
    assert!(no_cli.claude_mcp_servers.contains_key("demo-web"));
    registry::uninstall(&host, "demo").unwrap();
}

#[test]
fn native_names_are_safe_for_every_cli() {
    assert_eq!(
        native_name("acme.tools", "db server"),
        "acme-tools-db-server"
    );
}

#[test]
fn the_launcher_starts_only_a_plugin_that_is_on() {
    let tmp = Tmp::new("launcher");
    let host = host(&tmp);
    let source = tmp.path().join("src/demo");
    full_plugin(&source, "demo");
    let project = tmp.path().join("work/project");
    std::fs::create_dir_all(&project).unwrap();
    registry::install_local(&host, &source, Source::local(&source)).unwrap();
    let args = |server: &str, project: Option<&Path>| {
        let mut args: Vec<String> = [
            "--root",
            &host.root.display().to_string(),
            "--agents-skills",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        args.extend([
            host.agents_skills.display().to_string(),
            "--plugin".into(),
            "demo".into(),
            "--server".into(),
            server.into(),
        ]);
        if let Some(project) = project {
            args.extend(["--project".into(), project.display().to_string()]);
        }
        args
    };
    assert!(wiring::prepare_launch(&args("tools", None))
        .unwrap_err()
        .contains("switched off"));
    registry::enable(
        &host,
        "demo",
        &Scope::Project(project.display().to_string()),
    )
    .unwrap();
    assert!(
        wiring::prepare_launch(&args("tools", None)).is_err(),
        "not on everywhere"
    );
    assert!(wiring::prepare_launch(&args("missing", Some(&project))).is_err());

    std::env::set_var("MONOCODE_APP_TOKEN_TEST_ONLY", "secret");
    let command = wiring::prepare_launch(&args("tools", Some(&project))).unwrap();
    std::env::remove_var("MONOCODE_APP_TOKEN_TEST_ONLY");
    assert_eq!(
        command.get_program(),
        host.installed("demo")
            .canonicalize()
            .unwrap()
            .join("bin/server")
    );
    assert_eq!(
        command.get_current_dir(),
        Some(host.data("demo").canonicalize().unwrap().as_path())
    );
    let envs: Vec<(String, Option<String>)> = command
        .get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    assert!(
        envs.contains(&("MONOCODE_APP_TOKEN_TEST_ONLY".into(), None)),
        "the app's own variables are removed"
    );
    assert!(envs.iter().any(|(k, v)| k == "PLUGIN_ROOT" && v.is_some()));
    assert!(envs.iter().any(|(k, v)| k == "PLUGIN_DATA"
        && v.as_deref()
            == Some(
                &*host
                    .data("demo")
                    .canonicalize()
                    .unwrap()
                    .display()
                    .to_string()
            )));

    registry::uninstall(&host, "demo").unwrap();
    assert!(wiring::prepare_launch(&args("tools", Some(&project)))
        .unwrap_err()
        .contains("isn't installed"));
}

#[test]
fn transports_round_trip_as_tagged_json() {
    let value = serde_json::to_value(Transport::StreamableHttp {
        url: "https://x".into(),
        headers: Default::default(),
    })
    .unwrap();
    assert_eq!(value["type"], "streamable-http");
}

/// The launcher end to end: a plugin's stdio server (scripts/fake-mcp-server.mjs, run by node) started through
/// `prepare_launch` answers MCP, and reports it got PLUGIN_ROOT, PLUGIN_DATA and its working folder, and not the
/// app's connection token. Skipped where node isn't installed.
#[test]
fn a_plugin_server_runs_through_the_launcher_and_answers_mcp() {
    use std::io::{BufRead, BufReader, Write};
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("node isn't installed: skipped");
        return;
    }
    let tmp = Tmp::new("e2e");
    let host = host(&tmp);
    let source = tmp.path().join("src/live");
    write(&source.join("plugin.json"), &manifest("live"));
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-mcp-server.mjs"),
        {
            std::fs::create_dir_all(source.join("server")).unwrap();
            source.join("server/index.mjs")
        },
    )
    .unwrap();
    mcp(
        &source,
        json!({ "echo": { "type": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}/server/index.mjs"], "cwd": "${PLUGIN_DATA}" } }),
    );
    registry::install_local(&host, &source, Source::local(&source)).unwrap();
    registry::enable(&host, "live", &Scope::Global).unwrap();
    let wired = wiring::session_wiring(&host, None, Some("/app/monocode")).unwrap();
    let args: Vec<String> = wired.codex_mcp_servers["live-echo"]["args"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .map(|a| a.as_str().unwrap().to_string())
        .collect();

    std::env::set_var("MONOCODE_APP_TOKEN", "not-for-plugins");
    let mut command = wiring::prepare_launch(&args).unwrap();
    std::env::remove_var("MONOCODE_APP_TOKEN");
    let mut child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} })
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} })
    )
    .unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert!(line.contains("fake-plugin-server"), "{line}");
    line.clear();
    stdout.read_line(&mut line).unwrap();
    let _ = child.kill();
    let _ = child.wait();
    let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
    let tool = &reply["result"]["tools"][0];
    assert_eq!(tool["name"], "plugin_echo");
    let description = tool["description"].as_str().unwrap();
    let seen: serde_json::Value =
        serde_json::from_str(description.split("Started with ").nth(1).unwrap()).unwrap();
    let installed = host.installed("live").canonicalize().unwrap();
    let data = host.data("live").canonicalize().unwrap();
    assert_eq!(seen["root"], installed.display().to_string());
    assert_eq!(seen["data"], data.display().to_string());
    assert_eq!(seen["cwd"], data.display().to_string());
    assert_eq!(seen["appToken"], serde_json::Value::Null);
    registry::uninstall(&host, "live").unwrap();
}
