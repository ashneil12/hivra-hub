# WP-XX: Agents run inside an OS sandbox, with protected config paths (design first)

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

- None yet. This package is design first: it names paths once the design is agreed. `src/app/App.tsx`, `src-tauri/src/lib.rs` and `src/features/settings/ui/SettingsView.tsx` stay hook only.

## Done when

- [ ] Design doc with the platform matrix, measured startup cost and what each boundary cannot stop. A Claude agent that did not write it reviews it.
- [ ] Ash picks the mechanism per platform before any build.
- [ ] Once built, on a dev copy: an agent that reads ~/.ssh is refused, one that writes .git/hooks is refused, a run whose boundary fails does not start, and each refusal shows in the activity log.
- [ ] `npm run check` passes. Native checks stay open until seen in a dev copy on Ash's Mac.

## Licence

Ideas from Agentlas 2.0 (Appbridge Inc., announced 10 Nov 2026) and its public desktop repository (agentlas-ai/agentlas-desktop, Apache-2.0). No code is copied in this package. If a file is ever vendored, it gets its header, a NOTICE line and a credits.json entry, and this WP names it.
