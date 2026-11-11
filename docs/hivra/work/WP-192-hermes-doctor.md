# WP-192: The Hermes doctor

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | none (191 adds its language-server row) | no |

From PLAN.md, "From oh-my-hermes", item 7. oh-my-hermes is MIT (read at commit `2676c33`); idea only, credited per
SOURCES.md.

## Goal

One check, from Settings or from a chat, goes over everything Hermes needs to work in Hivra (installed, signed in,
profile, language servers, its memory database) and gives a short ordered list of what to fix, first thing first.
The report can be copied, and it never carries personal file contents, keys or paths outside what the person allows.

## What Hivra has

- Hermes binary resolution: `resolveHermesBinary` in `src/integrations/harness/core/child.ts`.
- Sign-in help: `HERMES_AUTH_HELP` in `hermesProtocol.ts` ("Configure Hermes with `hermes model`, then verify it with
  `hermes acp --check`"), and `hermesStartupError` that sorts a failed start.
- The Hermes home: `resolve_hermes_home` in `src-tauri/src/history_import.rs` (`HERMES_HOME` wins, else `~/.hermes`;
  `state.db` is its database; a profile named `default` stays on the root). Hermes skills folder `.hermes/skills`
  (`skills.rs`).
- The Settings health list (WP-104): `src-tauri/src/health.rs` reports machine facts, and
  `src/features/diagnostics/model/health.ts` turns facts into `HealthRow`s (`ok`, `check`, `problem`) with
  `CliHealth` for installed and signed in. `npm run hub:doctor` checks the app's own install, not a CLI.
- Secret scrubbing: `portable::scrubber`, used by diagnostics.

## What to build

1. **Facts, in Rust** (`src-tauri/src/hermes_doctor.rs`, new): each check returns a fact, never a sentence, with a
   5-second timeout each, in this order:
   1. installed: the resolved binary and its version, through the same version probe as WP-181a where it has landed;
   2. signed in: `hermes acp --check` exit status and its first line, scrubbed;
   3. profile: the Hermes home exists, which profile is active, the config file parses;
   4. model: the profile names a model, and it is one the Hermes catalog (`hermesCatalog.ts`) lists;
   5. language servers: for the open project's file types, which WP-191 servers are present (skipped with a note
      until WP-191 merges);
   6. memory database: `state.db` exists, opens read-only (`SQLITE_OPEN_READ_ONLY`), and passes `PRAGMA quick_check`;
      its size.
2. **Sentences and order, in TypeScript** (`src/features/diagnostics/model/hermesDoctor.ts`, pure): each fact becomes a
   row; problems come first, in check order, because a later check often fails because of an earlier one (not signed
   in makes "model" meaningless, so it says "check again after signing in"). Each problem row has one fix line, the
   exact command where there is one.
3. **Privacy flags.** The copied report shows paths with the home folder as `~`, never file contents, never the
   config's values (only which keys are present), and never a key, token or account email. A "Include paths" tick,
   off by default, adds full paths.
4. **Where it runs:** Settings > Diagnostics > "Check Hermes" (shown when Hermes is installed or was ever chosen), and
   an `app diagnostics.hermes` action so a first mate can run it when a Hermes worker fails to start.

## Rules

- Read-only. It never writes to the Hermes home, never runs `hermes model` or any setup, and opens `state.db`
  read-only.
- Runs only when asked; never on a timer.
- No new outward network call. `hermes acp --check` may reach Hermes's own provider, as when the person runs it.
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Credit oh-my-hermes (MIT) for the idea in the PR and update its row in SOURCES.md.
- Upstream rules from PLAN.md: new modules; `lib.rs` and the diagnostics panel get one-line hooks.

## Done when

- [ ] Red first: the ordering test, written first: not installed gives one problem and every later row "not checked";
      not signed in puts sign-in first and model as "check again after signing in".
- [ ] Rust tests with a fake `hermes` script and a temporary `HERMES_HOME`: each fact; a timeout is a timeout, not a
      failure; a corrupt `state.db` is reported and left unchanged (its bytes are compared before and after).
- [ ] Test: the copied report has `~` paths, no config values, and passes the existing secret scan with a seeded key
      in the config.
- [ ] Browser spec `tests/browser/hermes-doctor.spec.ts`: a seeded report with two problems in order, the copy button
      and the "Include paths" tick. Screenshot in the PR.
- [ ] `npm run check` passes.

## Not in this package

Fixing anything for the person. Doctors for other CLIs (the health list covers installed and signed in). Hermes's
own memory content.
