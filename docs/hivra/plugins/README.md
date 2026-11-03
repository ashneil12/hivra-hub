# Hivra plugins: format, registry and wiring (WP-30)

Hivra reads plugins in the open [Agent Plugins](https://agent-plugins.org/specification) format (schema 1.0.0), plus a
Hivra extension folder, and keeps a registry of what each installed plugin contributes so it can be switched off or
removed without leaving anything behind. Code: `src-tauri/src/plugins/` (Rust) and `src/features/plugins/` (the
session seams). Install from git or npm, updates and rollback are WP-31; this package installs local folders only.

## The format

```text
my-plugin/
├── plugin.json        required: "$schema" (the 1.0.0 identifier) and "name"
├── skills/<name>/SKILL.md
├── mcp.json           "$schema" + "mcpServers": stdio, streamable-http or sse
└── hivra/             Hivra's own extensions (see below)
```

The loader (`manifest.rs`, `mcp.rs`) follows the standard's failure boundaries:

| What is wrong | What happens |
| --- | --- |
| No `plugin.json`, unknown `$schema`, bad `name`, a field of the wrong type | the plugin is refused |
| An unknown top-level field, a non-object `extensions` | reported and ignored |
| One skill (no frontmatter, name not equal to its folder, no description) | that skill is skipped |
| A skill whose frontmatter sets `hooks` or `allowed-tools` (or hides keys behind a flow map, `?` or `<<`) | that skill is skipped: Claude Code would run its hooks as shell commands and pre-approve its tools, and a plugin skill is only instructions |
| `mcp.json` broken, wrong schema or version | MCP is off for that plugin, skills still load |
| One server (a name outside 1-64 letters, digits, `-`, `_`; a shell string as `command`, `../`, an `http` URL off this machine, reserved env names…) | that server is skipped |
| Any path that resolves outside the plugin (links included) | refused at the narrowest level |

Everything skipped comes back as a plain-words report. Nothing is ever fetched or run while loading.

## Hivra's extension folder

The standard wants a reverse-domain name. Until Ash confirms Hivra's domain the folder is `hivra/`
(`hivra::NAMESPACE`, the one constant to change). One validator per type; a broken item is skipped, the rest load.

| Path | Type | Valid when | Read by |
| --- | --- | --- | --- |
| `panels/<id>/panel.json` | dashboard | a Pages spec: `blocks` (1-12 known blocks) or `bespoke` with `index.html` beside it (optional `style.css`, `script.js`) and only permissions pageSpec.ts knows | WP-33 |
| `personas/<id>.md` | council persona | council-of-high-intelligence's format: frontmatter `name` equal to the file name, a `description`, persona text | WP-23 |
| `monos/<id>/mono.json` + `SOUL.md` | Mono template | `name`; optional `role`, `skills` (skill names), `crewRules`, `habits` (`title`, `schedule`, `prompt`); a non-empty soul | WP-05 |
| `crew-rules.json` | default crew rules | `{ "rules": [{ "match": { "labels"/"paths" }, "cli"/"model"/"effort" }] }`, a known CLI and effort | WP-13 |
| `commands/<name>.md` | slash command | a non-empty prompt, optional frontmatter `description` | later |

## The registry

`<app data>/plugins/registry.json` lists each installed plugin: name, version, source, where it is on (everywhere and/or
per project folder) and every contribution it made, in order. Each contribution has a disposer:

| Contribution | Made when | Undone by |
| --- | --- | --- |
| `files` (`installed/<name>`), `data` (`data/<name>`, its `PLUGIN_DATA`) | install | uninstall removes the folders |
| `claude-shim` (`claude/<name>`) | on anywhere | removing the folder |
| `skill-link` (`<agents skills>/<skill>`) | on everywhere | removing the link, only if it still points at the plugin |
| `skill`, `mcp-server`, `panel`, `persona`, `mono-template`, `crew-rules`, `command` | on anywhere | dropping the record (sessions and screens read the records) |

Install validates first, copies into a staging folder (following in-plugin links once per real folder, so links can't
loop) and renames it into place; any failure removes what was made, and an `installed/<name>` an unfinished install
left is cleared first. Enable undoes what it just made if the registry can't be written, and `registry.json` is synced
to disk before it replaces the old one. A disposer refuses any recorded path outside `<app data>/plugins` (or, for a
skill link, outside the skills folder), so a hand-edited registry can't make it remove anything else. A project scope
must be a full path; it is stored resolved and compared resolved, and an empty one is refused rather than read as
"everywhere". A
skill name already taken in the user's skills folder is reported and left alone, never replaced. Folders the registry
had to create are removed again once empty, and `registry.json` itself goes once nothing is installed. The Rust test
`install_enable_disable_uninstall_leave_no_trace` lists the file tree before install and after uninstall and requires
them to be equal.

Tauri commands: `plugins_list`, `plugins_inspect`, `plugins_install_local`, `plugins_enable`, `plugins_disable`,
`plugins_uninstall` (scope: no project = everywhere) and `plugins_session_wiring`.

## How each CLI gets a plugin

| CLI | Skills | MCP servers | Proof |
| --- | --- | --- | --- |
| **Claude Code** | `--plugin-dir <app data>/plugins/claude/<name>`: a Claude Code plugin whose `skills/` holds one link per skill that loaded (no hooks, agents, `.mcp.json` or skipped skills come along). Works per project. | merged into the session's one `--mcp-config` (the app's own entries keep their names) | Claude Code 2.1.317 `--plugin-dir … plugin details pstack` lists all 58 pstack skills through per-skill links; `pluginSessions.test.ts` (fake CLI, fed the wiring, files and launch the Rust test recorded in `__fixtures__/rust-wiring.json`) |
| **Codex** | a link per skill in `~/.agents/skills` while the plugin is on everywhere (Codex scans it: codex-rs `ext/skills/src/host_roots.rs`). Not per project. | `thread/start` / `thread/resume` `config.mcp_servers`, which Codex merges over the user's own servers; legacy `sse` servers are skipped with a report | `pluginSessions.test.ts` (fake CLI) |
| Cursor, OpenCode, Pi and the other `.agents/skills` readers | the same `~/.agents/skills` links | not wired yet | none yet |

Every plugin server goes by `plugin__<plugin>__<server>` in a session (a plugin's periods become `_`; plugin names
can't hold `_`, so the first `__` after the prefix always ends the plugin's part and two plugins can't produce the same
name). A name the person already uses in any CLI config the app knows (crate::mcp's discovery: Claude, Codex, Cursor,
OpenCode, Claude Desktop, user and project) is left out with a report: Codex would merge the person's entry with the
plugin's, handing it their headers, token or env, and Claude would swap their server for the plugin's.

A stdio server always starts as `<app> plugin-mcp --root … --plugin <name> --server <name> [--project <dir>]`. The
launcher checks the plugin is still on (for that project), loads `mcp.json` again, and starts the plugin's program
with `PLUGIN_ROOT`, `PLUGIN_DATA` and its working folder (§7.2, §9), from a clean environment: only `PATH`, `HOME`, the
user, shell, terminal, locale (`LANG`, `LC_*`), `TZ`, temp folders and, on Windows, the system folders a program needs,
plus the server's own `env`. API keys, `ANTHROPIC_AUTH_TOKEN` and the app's `MONOCODE_*` connection never reach it
(`wiring::PASSED_ENV`). Remote servers go to the CLI as URLs. Plugins never run code in the app's process.

### Dev copies and temporary homes

The daily app and a copy under a temporary HOME link skills into that HOME's `~/.agents/skills`. A dev copy on the real
HOME keeps them in its own `plugins/agents-skills` folder (listed in its Skills screen), so Ash's own CLIs never see a
dev copy's plugins; its Codex sessions then don't get plugin skills. A dev copy's Claude keeps only the app's delegate
server (CLAUDE.md, `isolated_dev_claude_args`), so plugin MCP servers are stripped there too; plugin skills still load.
Loosening that rule for the copy's own `plugin-mcp` entries is a separate decision.

## Not in this package

Pinned git/npm installs, update and rollback, install-script approval (WP-31); Discover (WP-32); panels on screen
(WP-33); pstack shipped by default (WP-41); a Settings screen for plugins.
