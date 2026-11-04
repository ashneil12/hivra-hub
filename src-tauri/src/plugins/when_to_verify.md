---
name: when-to-verify
description: When a worker should prove a change a person can see, and when to leave Verify unused.
---

Use this when the change is something a person sees in a browser or on a phone. The Verify server drives that app. Keep the proof in `.e2e/` (`report.json`, `trace.md`, screenshots, video) so it is attached to the worker's report.

Do not use this for a native desktop window, a command-line tool, or a library. Verify cannot drive those. Say so and stop.

The package's own e2e skill says how to write a run. Read that. Do not repeat it here.
