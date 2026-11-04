# Crew (Hivra WP-13)

Which CLI, model and effort a task uses, and what happens when that CLI fails for account reasons.

The same decisions live in TypeScript (`model/`) for Settings and in Rust (`src-tauri/src/crew/`) for the row and the timer. A task failure never reroutes, on either side.

- **Rules**, per project and per Mono, in order. A rule matches labels the first mate sets, or paths, and both when it sets both. The person's Mono rules, then the project's, then enabled plugin `crew-rules.json` rules. The first match wins.
- **Precedence**, one field at a time: the person's override, then the brief's request, then that rule, then the default. An unknown CLI or effort is skipped.
- **Default**: Claude Code when it is installed and signed in, otherwise the first signed-in CLI. Nothing signed in leaves the CLI empty.
- **Role models**: planning help and verdict checks use a cheap model at low effort. The work uses the rule's model. This is ROMA's idea; no ROMA text is included.
- **Reroute**: quota, rate limit, auth, billing and a missing CLI move to the next signed-in CLI under a retry budget (default 2). The work itself goes to the first mate. A timeout is tried again on the same CLI. The tries are a ledger on the row.
- **Usage limit**: with a known `resets_at` and no other CLI, the row is paused and resumed by the watcher tick when the time comes. Another signed-in CLI is used instead of waiting. A cancelled row is not reopened.

`bin/fm-dispatch-resolve.sh` is not ported: its job is a network model call, which this package does not ask for. The precedence comes from firstmate's `AGENTS.md`. The failure classes and `retry(n)` are translated from Puppetmaster.

Credit: firstmate (MIT), Puppetmaster (MIT). See `NOTICE`.
