---
name: write-panel
description: Write a panel into the scratch plugin, then check that it renders in the sandbox.
---

# Write a panel

Write `hivra/panels/<id>/panel.json` and `index.html` in the scratch folder only. A bespoke panel needs `kind`, `title` and `permissions`. Put the words in a paragraph, not only a heading.

The app validates the plugin. The panel has to render in the sandbox.

If you also add an MCP server, it does not run until the person says yes, and it has to answer tools/list.

Never change Hivra's own code. That goes through a dev copy and ship.

Write the files, then call app creator.draft with them, and read creator.state for the reports.
