---
name: write-mono
description: Write a Mono into the scratch plugin, then check that it loads.
---

# Write a Mono

Write `hivra/monos/<id>/mono.json` and a non-empty `SOUL.md` in the scratch folder only. `mono.json` has `name` and, if you want, `role` and `skills`.

The app validates the plugin. A Mono that does not load is skipped, and this one has to load.

If you also add an MCP server, it does not run until the person says yes, and it has to answer tools/list.

Never change Hivra's own code. That goes through a dev copy and ship.
