# WP-191: Code navigation tools for Hermes workers (language servers)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | L | none (the Hermes provider is on main) | no |

From PLAN.md, "From oh-my-hermes", item 6 (LSP tools). oh-my-hermes is MIT (read at commit `2676c33`); idea only,
credited per SOURCES.md.

## Goal

A Hermes worker can ask where a symbol is defined, where it is used, what the language server reports as errors in a
file, and what a rename would change, through four tools that answer from a real language server. When no language
server is installed for that file's language, the tool says so plainly and does nothing else.

## What Hivra has

- The Hermes provider (`src/integrations/harness/providers/hermes/hermes.ts`) speaks ACP. It opens a session with
  `session/new` and resumes with `session/load`, both with `mcpServers: []` (around lines 286 and 303), so Hermes gets
  no tools from Hivra.
- Hivra already serves stdio MCP servers from its own binary: `monocode mcp` (the delegate tool, `mcp_server.rs`) and
  `monocode plugin-mcp` (a plugin's server, `src-tauri/src/plugins/wiring.rs`), both started from `main.rs`.
- No code in the tree speaks the Language Server Protocol.

## What to build

1. **A stdio MCP server** `monocode lsp-mcp --root <worktree>` (new `src-tauri/src/lsp_tools/`, one `main.rs` line).
   Four tools:
   - `lsp_definition(path, line, character)` and `lsp_references(path, line, character)`: locations as path, line and
     character, paths relative to the root.
   - `lsp_diagnostics(path)`: the server's errors and warnings for that file.
   - `lsp_rename_preview(path, line, character, new_name)`: the edits a rename would make, as a list. It applies
     nothing; the worker makes the edits with its own tools, so its usual approvals apply.
2. **Positions are UTF-16,** as LSP defines them: `line` is 0-based, `character` counts UTF-16 code units. The tool
   descriptions say so, and the server converts to and from the file's text exactly (a helper with its own tests for
   emoji, CJK and combining marks).
3. **Language servers.** A fixed table maps file extensions to known servers (rust-analyzer, typescript-language-server,
   pyright or pylsp, gopls), found on PATH or in the project's `node_modules/.bin`. Each is started once per root on
   first use, in its own process group, and stopped when the MCP server exits or after 10 idle minutes.
4. **Fail closed.** No server for the extension, a server that fails to start, or no answer in 10 seconds returns a
   tool error "No language server for .rs files on this machine" (or the timeout in words), never an empty result
   that looks like "no references".
5. **Paths stay inside the root.** A path outside the worktree, through `..` or a symlink, is refused. Locations the
   server reports outside the root (a dependency's source) are returned as read-only with a marker.
6. **Wiring.** `hermes.ts` passes the server in `mcpServers` for a session whose project turns on Settings > Crew >
   "Code navigation tools for Hermes workers", off by default, with the worker's worktree as the root.

## Rules

- Off by default per project. With it off, `mcpServers` stays `[]` (tested).
- The tools read only. No rename or code action is applied by the server.
- Starts only the servers in the fixed table, from PATH or `node_modules/.bin`, never a path a worker supplies.
- No new outward network call by Hivra (a language server's own behaviour is the person's choice of server).
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Credit oh-my-hermes (MIT) for the idea in the PR and update its row in SOURCES.md.
- Upstream rules from PLAN.md: new module; `main.rs` and `hermes.ts` get the smallest hooks.

## Done when

- [ ] Red first: a test starts `lsp-mcp` on a fixture with no server for `.xyz` and expects the fail-closed error; it
      fails before the server exists.
- [ ] UTF-16 tests: a symbol after an emoji and after CJK text maps to the right byte offset and back.
- [ ] Tests with a fake language server (a small stdio script in test fixtures): definition, references, diagnostics
      and rename preview; a timeout; a path outside the root refused; the idle stop.
- [ ] Test: Hermes's `session/new` carries the server only with the setting on.
- [ ] Browser spec `tests/browser/hermes-lsp-setting.spec.ts`: the project setting, off by default, kept after reload.
- [ ] One test against a real `typescript-language-server` runs where it is installed and is skipped with a stated
      reason where it is not (the PR lists which ran).
- [ ] `npm run check` passes. A dev-copy check with a real Hermes worker stays open until done.

## Not in this package

The same tools for other CLIs (each has its own; a later package can pass this server to any ACP CLI). Installing
language servers. The Hermes doctor's language-server row (WP-192 reads it from here).
