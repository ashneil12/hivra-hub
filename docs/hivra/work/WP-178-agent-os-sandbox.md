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

- Built: the probe and its test (`scripts/agent-sandbox-probe.mjs`), the protected-paths list with 31 tests in
  `protectedPaths.ts`, and `checkTurnForProtectedPaths`, the report-only after-turn check.
- Not built, on purpose: the check is not wired into a turn (the fingerprint snapshot needs a Rust command in
  `lib.rs`, a shared hotspot, and waits on the mechanism). No confinement of any runtime. The secret-paths list (item 3),
  fail-closed startup (item 4) and refusal logging (item 5) are not built in this round.

### Decisions for Ash

1. macOS: keep the denylist as the first boundary (measured, cheap, leaks outside its list), or hold until the
   deny-default profile starts a binary and its cost is measured?
2. Linux and Windows: measure on a real machine before picking, or pick now and measure later?
3. After-turn check: wire it into every turn (needs a Rust fingerprint command in `lib.rs`), or keep it on first-mate
   turns only, as WP-10 does?
4. Secret-paths list: build it in the next round, with the same report-only first step?

### Done when, status

- [ ] Design doc with the platform matrix, measured startup cost and what each boundary cannot stop. macOS measured;
  Linux and Windows not measured. A Claude agent that did not write it reviews it: pending.
- [ ] Ash picks the mechanism per platform before any build: pending (decisions above).
- [ ] Once built, on a dev copy: pending. Nothing is built that confines a runtime.
- [ ] `npm run check` passes. Not run; scoped checks run instead (tsc, the two test files, node test). Native checks
  stay open until seen in a dev copy on Ash's Mac.

## Licence

Ideas from Agentlas 2.0 (Appbridge Inc., announced 10 Nov 2026) and its public desktop repository (agentlas-ai/agentlas-desktop, Apache-2.0). No code is copied in this package. If a file is ever vendored, it gets its header, a NOTICE line and a credits.json entry, and this WP names it.
