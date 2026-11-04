# Discover

WP-32. Discover lists plugins from static indexes. It reads each index's text and maps the entries. It never opens,
downloads or runs a plugin. Installing an entry is WP-31's `plugins_install`, and only when the readers marked that
entry available and it carries a pinned source.

## Where an index comes from

Settings keeps the list. The default is the bundled index, `plugins/index.json`, built into the app so Discover works
offline. A source is one of:

- `{"kind":"bundled"}`
- `{"kind":"url","url":"https://…"}` — https only, and the address cannot contain a password
- `{"kind":"github","repo":"owner/name","ref":"optional"}` — the Claude Code marketplace at
  `.claude-plugin/marketplace.json` in that repository, read at a commit
- `{"kind":"file","path":"…"}` — a file on this computer. The path is stored as given, including spaces

At most 20 sources. A source that isn't one of those, or a duplicate, is dropped. An empty list falls back to the
bundled index. Two windows share the list: a window writes only when the stored revision is still the one it read,
and otherwise it shows the other window's list.

A source that doesn't answer (nothing came back, a timeout, a missing file) fails on its own and can be tried again.
That failure does not mark any plugin not compatible. A broken index (not JSON, a format Hivra doesn't know) lists
nothing from that source and says why. The other sources still list.

## The three formats

Readers map every index into one entry. `format` is `hivra`, `dsh` or `claude-marketplace`.

**Hivra** (`"format": "hivra-plugin-index/1"`) is a list of plugins: name, description, version, a pinned source,
licence, platforms, author, and a summary of what it adds. An available entry's source is a git URL pinned to a
40-character commit, or an npm package pinned to an exact version. A planned entry has no install source, so Install
is not offered. An entry whose source isn't pinned is listed only.

**DeepSeek Harness** (`"format": 1`) maps into the same entry. Every entry is not compatible: a DeepSeek Harness
bundle runs inside DeepSeek Harness's own agent loop. None of them is offered for install.

**Claude Code** (`.claude-plugin/marketplace.json`). Skills and MCP servers are portable, so the entry is listed, but
Hivra can't install Claude Code's plugin layout yet, so Install is not offered. An entry that only has hooks, agents,
commands, language servers or output styles is not compatible: those parts run inside Claude Code itself.

## The screen

Settings → Plugins. Search, filter by what a plugin adds, and a detail with the licence, the source, what it adds and
its permissions. Install is shown only for an available entry with a pinned source, and it calls `plugins_install`
with that source. If that command isn't in this build, the screen says so and nothing is marked installed.
