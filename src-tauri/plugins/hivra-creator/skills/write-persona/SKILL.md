---
name: write-persona
description: Write a persona into the scratch plugin, then check that it loads.
---

# Write a persona

Write `hivra/personas/<id>.md` in the scratch folder only. Frontmatter `name` equals the file name, with a description, then the persona's text.

The app validates the plugin. A persona that does not load is skipped, and this one has to load.

If you also add an MCP server, it does not run until the person says yes, and it has to answer tools/list.

Never change Hivra's own code. That goes through a dev copy and ship.

Write the files, then call app creator.draft with them, and read creator.state for the reports.
