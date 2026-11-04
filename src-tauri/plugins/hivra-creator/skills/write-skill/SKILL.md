---
name: write-skill
description: Write a skill into the scratch plugin, then check that it parses.
---

# Write a skill

Write `skills/<name>/SKILL.md` in the scratch folder only. The name matches the folder. Frontmatter has `name` and `description`. Do not add hooks or allowed-tools.

The app validates the plugin. A skill that does not parse is skipped, and this one has to parse.

If you also add an MCP server, it does not run until the person says yes, and it has to answer tools/list.

Never change Hivra's own code. That goes through a dev copy and ship.

Write the files, then call app creator.draft with them, and read creator.state for the reports.
