# WP-178: Agents run inside an OS sandbox, with protected config paths (design first)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Unassigned (Ash to place after WP-60) | M | 60 | no |

This package is the design. It changes no runtime until Ash picks the mechanism.

## Goal

Every agent process Hivra starts (its terminal, its shell commands and the CLI it runs) works inside an operating-system boundary. The boundary stops it reading the person's secrets outside the project and stops it changing the files that decide what runs: git hooks, shell profiles, and the CLI's own settings and hooks.

## Why

Hivra runs Claude Code, Codex, Hermes and other CLIs, and its own terminals, with the person's own permissions on this Mac. Nothing in the tree confines them. A search of src-tauri/src and src for process confinement (sandbox-exec, seatbelt, landlock) found none, so a CLI can read ~/.ssh or write .git/hooks. Rules in prompts are not a boundary.

Agentlas 2.0 claims an OS-sandboxed terminal for each downloaded agent, with no VM and idle agents asleep. Its public desktop repo has a confined shell with a list of secret paths and a list of protected project paths. Those are ideas only here: we take the design and write our own policy, and copy nothing.

## Read first

- The process spawn path for harness CLIs and terminals (harness.rs, named in WP-10; the terminal module under src/features/terminal). Confirm the exact files with the code graph before building.
- WP-10's read-only enforcement per CLI and its after-turn check on the main checkout.
- WP-44 (desktop control, headless-first safety) and WP-43 (browser profiles, driving indicator).
- WP-92 (secret vault): secrets reach a command through the vault, never through a file the agent can read.
- WP-60 and WP-61 (host and cloud, where the same boundary must also hold on a remote machine).

## Build

1. A platform matrix in the design doc: macOS, Linux and Windows. For each, the boundary that exists, what it cannot stop, and the startup cost, measured on a dev copy. Pick one per platform by that measurement. Do not ship a boundary that only looks like one.
2. One protected-paths file: git hooks, git config, shell profiles, and each CLI's settings, hooks, commands and skills folders. The boundary denies writes to them, and the after-turn check in WP-10 flags any that change anyway.
3. One secret-paths list: ~/.ssh, cloud credential folders, GnuPG, password stores and the OS keychain or keyring. Denied to agent processes. Secrets reach a command only through WP-92.
4. Fail closed. If the boundary cannot be set up, the run does not start, and the chat says why in plain words.
5. Each refusal goes to the activity log (WP-78), with the path and the agent that tried.

## Don't

- Don't build a second terminal stack, and don't change upstream terminal code beyond a small hook.
- Don't treat a prompt instruction as the boundary.
- Don't copy another product's policy file. Write the lists from this design.

## Owned paths

- `scripts/agent-sandbox-probe.mjs` and its test: the macOS measurement. It runs probes under a temporary HOME and starts no agent.
- `src/integrations/harness/core/protectedPaths.ts` and its test: the protected-paths list, the matcher, and the report-only after-turn check.
- `src/app/App.tsx`, `src-tauri/src/lib.rs` and `src/features/settings/ui/SettingsView.tsx` stay hook only. Nothing in them changed.

## Done when

- [ ] Design doc with the platform matrix, measured startup cost and what each boundary cannot stop. A Claude agent that did not write it reviews it.
- [ ] Ash picks the mechanism per platform before any build.
- [ ] Once built, on a dev copy: an agent that reads ~/.ssh is refused, one that writes .git/hooks is refused, a run whose boundary fails does not start, and each refusal shows in the activity log.
- [ ] `npm run check` passes. Native checks stay open until seen in a dev copy on Ash's Mac.

## Measured (WP-178, 10 Nov 2026)

Measured with `node scripts/agent-sandbox-probe.mjs` on one Mac (macOS 26.6.2) under a temporary HOME and a scratch
project. No dev copy was launched and no agent was started. The native check (a dev copy on Ash's Mac) is still open.

### Platform matrix

| Platform | Boundary | Measured | What it stops | What it cannot stop | Startup cost |
| --- | --- | --- | --- | --- | --- |
| macOS | `sandbox-exec`, denylist profile (allow default; deny reads and writes of `~/.ssh` and `~/.zshrc`, deny writes of `.git/hooks` and `.git/config`) | Yes. Refused: read `~/.ssh`, read `~/.zshrc`, write `.git/hooks/pre-commit`, write `.git/config`. Allowed: read a file outside the list, write `src/`, read the README. | The listed paths only | Anything not on the list (a file in `~/Documents` was read). Network, since the profile is allow default. Writes inside the project, by design. Keychain and environment variables: not measured. | `/usr/bin/true`: median 1.2 to 3.0 ms plain, 6.7 to 12.5 ms under the profile. `git status`: median 9.3 to 25.5 ms plain, 14.5 to 32.5 ms under it. Ranges are three runs of 5 to 20 on this Mac; load from other builds moves them. |
| macOS | Deny-default allowlist | Not measured. Every profile tried refused the exec of `/usr/bin/true` (exit 71), and a broader one aborted (exit 134). | Unknown | Unknown | Unknown until a profile starts a binary |
| Linux | Landlock (kernel 5.13 or later) | Not measured: no Linux machine in this session | n/a | n/a | n/a |
| Windows | AppContainer, restricted token or job objects | Not measured: no Windows machine in this session | n/a | n/a | n/a |

The pick per platform is Ash's (below). The macOS denylist is the only boundary measured to work here, and it leaks
everything outside its list. The deny-default profile is what would close that gap, and it does not start yet.

### What the measurement shows about the existing guards

- The WP-10 checkout guard (`src-tauri/src/firstmate/checkout_guard.rs`) reads `git status`. Reproduced: writing
  `.git/hooks/pre-commit` and appending to `.git/config` leave `git status` unchanged. So the guard cannot see either
  file. The after-turn check for protected paths needs fingerprints of the protected files, taken by the caller.
- `src/integrations/harness/core/credentialGuard.ts` already passes Claude Code deny rules for `~/.ssh/**` and other
  credential files, but only for Claude, and only as a rule the CLI applies. A process boundary would cover every CLI
  and every shell command, which is the gap this package is for.
- `scripts/bench-sandbox.mjs` already runs the bench's agents under a seatbelt profile. That is a test harness, not
  the app's runtime. It is a precedent for the mechanism, not a boundary for real runs.

### What is built, and what is not

- Built: the probe and its test (`scripts/agent-sandbox-probe.mjs`), the protected-paths list in `protectedPaths.ts`,
  the secret-paths list, `checkTurnForProtectedPaths` (the report-only after-turn check), its wiring into first-mate
  turns, the macOS sandbox profile behind a setting (`agent_sandbox.rs`), fail-closed startup, a start-up self-check,
  the Settings switch, and activity rows for a refused start and for a protected-path report.
- Not built: a Linux or Windows boundary. A single refused read or write inside a running agent is not logged:
  `sandbox-exec` does not report denials to the app.
- The probe script still measures the earlier `subpath` and `literal` profile. The app ships the regex profile built by
  `agent_sandbox.rs`: case-folded, with the review r2 denies (the switch folder, `monocode.db`, the git writes, the
  denied programs, Apple events, file links). The probe results for the shipped profile are in the PR comments.

### Decisions (Ash's picks, built in this round)

Ash approved the lead's picks. Each one below is what the code does now.

1. **macOS: the denylist is the first boundary, off by default.** It is on only when the setting is on. The setting is
   `<app data>/settings/agent-sandbox` containing `on`, or the environment switch `MONOCODE_AGENT_SANDBOX=1`, which
   wins over the file. When it is on, `harness_spawn` starts each agent CLI as
   `/usr/bin/sandbox-exec -p <profile> <cli> <args>` (src-tauri/src/agent_sandbox.rs). The profile denies reads and
   writes of the secret places and shell profiles, and writes to `.git/hooks` and `.git/config` in any checkout. The
   denylist leaks everything it does not list (measured above), and that stays a known limit. The deny-default profile
   is not built: it has not started a binary in this measurement.
2. **Fail closed.** Before a sandboxed start, `sandbox-exec` runs `/usr/bin/true` under the same profile. If that does
   not start, the agent does not start, and the chat gets a plain line. The app never falls back to an unsandboxed
   start while the setting is on.
3. **Linux and Windows: measured later, hidden for now.** Neither boundary is measured on a real machine yet (see the
   matrix), so there is no setting for either. The setting reads as off and is not offered off macOS
   (`agent_sandbox::enabled` returns false outside macOS). Measure Landlock and AppContainer on a real machine before a
   pick.
4. **After-turn check: first-mate turns only, report only.** `FirstMateTurnGuard.endProtected` compares the fingerprints
   taken at the turn's start and end (`firstmate_protected_fingerprints`, src-tauri/src/firstmate/protected_paths.rs).
   It names what changed in `.git/hooks`, `.git/config` and the secret places, and never blocks or reverts anything.
   The fingerprints for `.git/hooks` and `.git/config` are content hashes. The secret places are size and modified time
   only, never content, so the check does not read keys.
5. **Secret-paths list: report only, in the same after-turn check.** The list is the `homeSecrets` section of the
   shared list `src/shared/security/agentConfigPaths.json` (the file the delivery floor reads too). The TypeScript check
   and the Rust sandbox profile both read it, so they cannot drift. It is home-anchored, not matched at any depth, so
   the sandbox never denies a folder such as `<repo>/.git` or `~/.claude`. The CLI's own login files (`~/.claude.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`) are
   reported but not denied by the sandbox, because the CLI reads them to log in, and a denial would stop it from
   starting. That is a gap Ash should decide on.

Not built in this round, on purpose:
- Built later in this round: a Settings > General switch (it writes the same file the app reads), activity rows for a
  refused start (`sandbox.refuse`) and for a first-mate turn that touched a protected or secret place
  (`protected.report`), and the reconciled shared list (one list, `homeSecrets`).
- A refusal of an individual read or write is not logged. `sandbox-exec` does not report a denied access to the app,
  so only a refused start and the after-turn report reach the activity log.
- Confinement for the user's own terminal (WP-44 and the terminal module). Only the agent CLI process is started under
  the profile, not every shell the terminal opens.

### Done when, status

- [ ] Design doc with the platform matrix, measured startup cost and what each boundary cannot stop. macOS measured;
  Linux and Windows not measured. A Claude agent that did not write it reviews it: pending.
- [ ] Ash picks the mechanism per platform before any build: pending (decisions above).
- [ ] Once built, on a dev copy: pending. The macOS profile is built and was probed under a temporary home with
  `sandbox-exec` (review r2). The native check on a dev copy is still open.
- [ ] `npm run check` passes. Not run; scoped checks run instead (tsc, the two test files, node test). Native checks
  stay open until seen in a dev copy on Ash's Mac.

## Limits

- The seatbelt profile grows by about 9.4 KB for each known project. It is refused, and nothing starts, once the
  profile is 900,000 bytes (under the about 1 MiB argument limit). That is around 110 to 220 projects. The error is
  "The sandbox profile is too large to apply, so nothing starts."
- `project_folders` keeps an absolute path with no `..` and no null. Anything else is skipped, not expanded, so a
  folder written as `~/Projects/name` is not locked.
- Ash's own commit, push, pull and fetch run with git hooks on, and not inside the container. An in-tree hook such as
  `core.hooksPath=.husky` still runs on those commands.
- A self-build Apply runs the project's src tests.
- The container profile denies writes to `.git/hooks` and `.git/config` for known projects. It does not deny the rest
  of `.git`, so the index stays writable. The agent profile denies the whole `.git`.
- The ship record mac signs the id, both stamps (`to.sha` and `from.sha`), the app path, the data dir, home, the
  launch mode and env, and the launchd plist. It does not sign `phase` or `steps`, because the runner writes those on
  a real ship and a mac of them would fail. Startup also leaves a record alone when its id is not the ship folder
  name. The data folder is write-denied while the sandbox is on, so an agent cannot rewrite that record in place.
  Startup itself runs outside the sandbox, which is why the mac and the folder check are there.

## Licence

Ideas from Agentlas 2.0 (Appbridge Inc., announced 10 Nov 2026) and its public desktop repository (agentlas-ai/agentlas-desktop, Apache-2.0). No code is copied in this package. If a file is ever vendored, it gets its header, a NOTICE line and a credits.json entry, and this WP names it.
