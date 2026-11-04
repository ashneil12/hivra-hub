---
name: write-command
description: Write a slash command into the scratch plugin, then check that it loads.
---

# Write a slash command

Write `hivra/commands/<name>.md` in the scratch folder only. The prompt after the frontmatter is the command. A description in the frontmatter is optional.

The app validates the plugin. A command that does not load is skipped, and this one has to load.

If you also add an MCP server, it does not run until the person says yes, and it has to answer tools/list.

Never change Hivra's own code. That goes through a dev copy and ship.

Write the files, then call app creator.draft with them, and read creator.state for the reports.
