# Hivra plugins: format, registry and wiring (WP-30)

Hivra reads plugins in the open [Agent Plugins](https://agent-plugins.org/specification) format (schema 1.0.0), plus a
Hivra extension folder, and keeps a registry of what each installed plugin contributes so it can be switched off or
removed without leaving anything behind. Code: `src-tauri/src/plugins/` (Rust) and `src/features/plugins/` (the
session seams). Installing from a pinned git or npm source, updating, rolling back and approving a script are
WP-31 (`install.rs`, `source.rs`, `compat.rs`); Discover is WP-32.

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
| A skill whose frontmatter sets `hooks` or `allowed-tools`, or isn't plain YAML (every line a column-0 `key:` of letters, digits, `-`, `_`, or indented under one: no escaped, tagged, aliased, merged, flow or wholly indented keys) | that skill is skipped: Claude Code would run its hooks as shell commands and pre-approve its tools, and a plugin skill is only instructions. Skills are checked again each time a session's wiring is built; one changed since it was switched on keeps the plugin's skills out of that session, and its link in `~/.agents/skills` is removed so Codex stops seeing it too |
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
`plugins_uninstall` (scope: no project = everywhere), `plugins_session_wiring`, (WP-31) `plugins_install`,
`plugins_update`, `plugins_approve`, `plugins_decline`, `plugins_pending`, `plugins_rollback`, and (WP-32)
`plugins_discover`.

## How each CLI gets a plugin

| CLI | Skills | MCP servers | Proof |
| --- | --- | --- | --- |
| **Claude Code** | `--plugin-dir <app data>/plugins/claude/<name>`: a Claude Code plugin whose `skills/` holds one link per skill that loaded (no hooks, agents, `.mcp.json` or skipped skills come along). Works per project. | merged into the session's one `--mcp-config` (the app's own entries keep their names) | Claude Code 2.1.317 `--plugin-dir … plugin details pstack` lists all 58 pstack skills through per-skill links; `pluginSessions.test.ts` (fake CLI, fed the wiring, files and launch the Rust test recorded in `__fixtures__/rust-wiring.json`) |
| **Codex** | a link per skill in `~/.agents/skills` while the plugin is on everywhere (Codex scans it: codex-rs `ext/skills/src/host_roots.rs`). Not per project. | `thread/start` / `thread/resume` `config.mcp_servers`, which Codex merges over the user's own servers; legacy `sse` servers are skipped with a report | `pluginSessions.test.ts` (fake CLI) |
| Cursor, OpenCode, Pi and the other `.agents/skills` readers | the same `~/.agents/skills` links | not wired yet | none yet |

Every plugin server goes by `plugin-<plugin>-<server>` in a session (a plugin's periods become `_`). The name never
holds `__`: Claude Code reads tool names as `mcp__<server>__<tool>` and splits on it, so a `__` inside would make every
plugin's server one server called `plugin` to its permission rules. Server names are 1-64 of letters, digits, `-` and
`_` without `__`. The rare pair that maps to one name (`a` + `b-c`, `a-b` + `c`) keeps the first and reports the second.
A name the person already uses in any CLI config the app knows (crate::mcp's discovery: Claude, Codex, Cursor,
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

## Installs (WP-31)

A source is a git address pinned to a full commit or a tag, an npm package at one exact version, or a local folder.
A branch, `latest` or a range is refused. Before a local git folder is cloned, and before an npm tarball is
downloaded, the declared platforms and Hivra version range are checked; a remote git commit is fetched into a scratch
repository with no checkout and its `plugin.json` is read from the object store before anything is unpacked. The
download is staged, validated with the loader above, and swapped into place. Any failure puts the installed version
back, and `lock.json` records the version, source and a digest of the files (no times, no on/off switch).

An install script, or an MCP server that needs `npm install`, is shown as the exact command and waits. An install an
agent starts waits too, even when nothing would run. Both show in the Inbox and on the Installed list until the person
allows or declines. A yes runs the command with no shell and the same limited environment a plugin server gets, plus
`PLUGIN_ROOT`. Update keeps the old version in `previous/<name>` until the new one validates; rollback puts it back in
one step; uninstall runs the disposers and removes the files, the previous copy and the lock entry.

Settings → Plugins has two tabs. Discover lists what you can add. Installed is what is on this machine (update, roll
back, remove).

## Default plugins (WP-41)

Hivra gives every data folder its default plugins once, on the first start that knows about them (a fresh install and
an existing one alike). Today that is **pstack** (Lauren Tan's skills for rigour and verification, MIT), so its 58
skills reach every first mate and worker.

- **Carried, not downloaded.** `src-tauri/plugins/<folder>` is a copy of the plugin at a pinned commit
  (`src-tauri/plugins/defaults.json`), embedded in the binary by `build.rs`. Nothing is fetched at start, and Linux
  and Windows builds (which carry no bundle resources) get it too. See
  [src-tauri/plugins/README.md](../../../src-tauri/plugins/README.md) for the pin and how to move it.
- **Installed like any plugin** (`plugins/defaults.rs`): unpacked into a staging folder under `<app data>/plugins`,
  installed through the registry (`install_local`, so it is validated and every contribution has a disposer) with
  source `bundled` at `https://github.com/cursor/plugins/tree/<commit>/pstack`, then switched on everywhere. It runs in
  the background at start (`lib.rs`), never blocking the window.
- **Given once.** `<app data>/plugins/defaults.json` records which defaults this data folder was given. Switched off
  stays off, removed stays removed, and a plugin by the same name the person installed themselves is never replaced
  or switched on. A start that fails (or stops between install and switch-on) records nothing and the next start
  finishes the job.
- **Turning it off:** like any plugin, `plugins_disable` (everywhere or one project) or `plugins_uninstall`. The
  Installed tab in Settings is WP-31's.
- **What each CLI gets:** what the table above says for any plugin on everywhere. Claude Code loads the skills through
  `--plugin-dir` (as `/pstack:<skill>`); Codex, Cursor, OpenCode, Pi and the other `.agents/skills` readers get a link
  per skill in `~/.agents/skills` (the daily app links into Ash's real home, so his own CLIs outside Hivra see pstack
  too; a skill name he already has there is left alone and reported). pstack has no MCP servers.
- **Left out of the copy:** pstack's `agents/` (two Cursor subagent definitions; Claude Code could read plugin agents,
  but WP-30's shim carries skills only, and pstack's own `docs/harness/claude-code.md` maps them to `general-purpose`),
  `automations/` (Cursor Automations, no CLI here runs them), `.cursor-plugin/`, the guide's images, the logo and the
  `statechart` skill's 3.8 MB test corpus (`scripts/test`; the skill's scripts don't read it).

Proofs: `plugins::defaults_tests` (the pin equals the carried folder byte for byte; a fresh install has pstack on with
all 58 skills for Claude Code and `.agents/skills`; later starts change nothing; off and removed stick; an existing
install gets it once; the person's own pstack is left alone; an interrupted or failed start finishes next time) and
`src/features/plugins/model/pstackSessions.test.ts` (the real Claude Code and Codex adapters, fed the wiring Rust
recorded in `__fixtures__/rust-pstack.json`, hand fake CLIs all 58 skills when on and none when off).

## Not in this package

Panels on screen (WP-33).
