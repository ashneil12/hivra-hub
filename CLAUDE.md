@AGENTS.md

The rules every agent follows are in [AGENTS.md](AGENTS.md), imported above. This file keeps only what is specific
to Claude Code.

## The dev copy's Claude

A dev copy runs Claude with MCP servers and hooks stripped in `~/.monocode-hub-dev/claude-config` (one Claude login
for every dev copy; it refuses to start if that folder can't be made). The one MCP server it keeps is the app's own
delegate tool (`monocode mcp`), exactly as the app writes it: it only reaches that copy's own control port.
