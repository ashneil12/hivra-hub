# Hivra: the build plan

33 work packages in four waves. A wave's packages run in parallel; a package starts when everything it depends on
has merged. Sizes are agent time: S is under two hours, M is half a day, L is about a day.

## How to take a package

1. Read [README.md](README.md), [SPEC.md](SPEC.md), this file, then your package in [work/](work/).
2. **Claim it** by opening a draft PR titled `WP-NN: <title>` as soon as you start. Open PRs are the status board;
   don't take a package that already has one.
3. Branch from `main` as `wp/NN-short-name`.
4. Stay inside the paths your package owns. If you must touch another package's paths or a shared hotspot
   (`src/app/App.tsx`, `src-tauri/src/lib.rs`, `src/features/settings/ui/SettingsView.tsx`), keep it to a small hook
   and say so in the PR.
5. Write the tests first where you can. Before marking the PR ready: `npm run check` passes, and for anything a
   person sees, a browser spec in `tests/browser/` passes and a screenshot is attached.
6. Put the evidence in the PR description: what you ran, what it printed, what you couldn't check (native window,
   real provider) and why.
7. One package per PR. Credit sources from [SOURCES.md](SOURCES.md) in the PR and in `NOTICE` when code is
   vendored.
8. Follow CLAUDE.md: never launch a build with the real HOME, never touch the daily app or its data, ship only
   through `hub:ship`.

## Review and landing

- Every PR gets a review by a Claude agent that did not write it, against the package's "Done when" list.
- PRs from Grok (or any agent Ash is unsure of) are welcome for packages marked **Grok OK**, and get the same
  review plus a check that nothing outside the package's paths changed.
- Native checks (anything only the real window shows) run in a dev copy on Ash's Mac (`npm run hub:dev`), started
  by Ash or through a Remote Control session. A package that needs one stays open until it is done; tests passing
  is not the same as verified in the app.
- The integrating Claude merges, with a merge commit, once the review passes and CI is green, or once the only
  failures left are ones `main` already has and the PR says so. Ash doesn't need to be asked. Nothing is shipped to
  the daily app until a wave is merged and checked in a dev copy.

## Upstream rules (every package)

- New features go in new modules. Upstream files get the smallest hook that works, with a comment naming the
  package.
- Don't reformat or reorder upstream code. Don't rename upstream symbols.
- Upstream is merged regularly (CLAUDE.md "Upstream merges"). A package that conflicts with a fresh upstream merge
  rebases; it doesn't fight upstream.

## The waves

### Wave A: clean base and foundations (start now, all in parallel)

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [01](work/WP-01-browser-tests.md) | Browser tests green | M | none | yes |
| [02](work/WP-02-windows-tests.md) | Windows tests green | M | none | no |
| [03](work/WP-03-one-layout.md) | One layout | M | none | no |
| [04](work/WP-04-retire-ash-os-bridge.md) | Retire the Ash OS bridge | L | none | no |
| [08](work/WP-08-credits.md) | Credits and notices | S | none | yes |
| [10](work/WP-10-first-mate-contract.md) | First mate contract | L | none | no |
| [22](work/WP-22-groups.md) | Groups: responder modes and goal mode | M | none | no |
| [30](work/WP-30-plugin-format.md) | Plugin format and registry | L | none | no |

### Wave B: the first mate's engine and plugin installs

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [05](work/WP-05-personas-to-monos.md) | Leadership personas become Mono templates | M | 10, 30 | no |
| [11](work/WP-11-watcher.md) | Watcher and wake queue | L | 10 | no |
| [12](work/WP-12-delivery.md) | Delivery modes and merge authority | M | 10 | no |
| [13](work/WP-13-crew-routing.md) | Crew routing and reroute | M | 10 | no |
| [14](work/WP-14-steering-decisions.md) | Steering and decisions | M | 10 | no |
| [40](work/WP-40-gates.md) | Completion and verdict gates | M | 10 | no |
| [31](work/WP-31-plugin-install.md) | Plugin install, update, rollback | L | 30 | no |
| [32](work/WP-32-discover.md) | Discover | M | 30 | yes |
| [41](work/WP-41-pstack.md) | pstack in every chat | S | 30 | yes |

### Wave C: what people see

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [15](work/WP-15-first-mate-ui.md) | First mate UI: Crew tab and Inbox | L | 03, 10, 11, 14 | no |
| [06](work/WP-06-retire-hub-screens.md) | Retire Today, Being built, Needs you | M | 15 | no |
| [20](work/WP-20-coding-team.md) | Coding team as every project's first mate | M | 11, 12, 13, 15 | no |
| [21](work/WP-21-monos-first-mates.md) | Monos are first mates | M | 05, 20 | no |
| [23](work/WP-23-council.md) | Council | L | 22 | no |
| [33](work/WP-33-panels.md) | Pages become panel plugins | M | 04, 31 | no |
| [34](work/WP-34-creator-mode.md) | Creator mode | L | 31, 33 | no |
| [42](work/WP-42-e2e-plugin.md) | e2e Verify plugin | S | 31 | yes |
| [43](work/WP-43-browser-plugin.md) | Browser plugin | M | 31 | yes |
| [44](work/WP-44-desktop-plugin.md) | Desktop control plugin | S | 31 | yes |

### Wave D: later (start when Ash says)

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [07](work/WP-07-rename.md) | Rename the app to Hivra | M | 06 | no |
| [09](work/WP-09-platform-parity.md) | Ship and autopilot on Windows and Linux | L | 02 | no |
| [50](work/WP-50-history-importer.md) | Chat-history importer | L | 21 | no |
| [51](work/WP-51-memory.md) | Memory curator, review screen, long chats everywhere | L | 50 | no |
| [60](work/WP-60-host-side-first-mate.md) | First mate on the remote host | L | 20 | no |
| [61](work/WP-61-hivra-cloud.md) | Hivra Cloud machine | L | 60 | no |

## Running it

- Each wave runs as one agent per package, in parallel (up to about ten at once). Wave A can start the moment this
  plan merges. A wave usually takes a day of agent time; the slow part is review and the dev-copy checks on Ash's
  Mac, so plan those in batches at the end of each wave.
- A package whose dependency sits in the same wave starts when that dependency's PR merges, or branches from that
  PR's branch and says so in its own PR (then it merges second).
- The integrating agent (Claude, in the project's main thread) keeps the board: watches the PRs, re-runs CI, resolves
  conflicts between packages, and tells Ash only what needs a decision or a merge.
- After each wave: merge upstream if it moved, run `npm run hub:verify-live` once as the end-to-end proof, then ask
  Ash whether to ship the wave to the daily app.

## Risks to watch

- **`App.tsx` conflicts.** It is about 17,000 lines and several packages hook into it. Keep hooks small, merge
  App.tsx-touching PRs one at a time, rebase the rest.
- **Retiring code that is still used.** Packages 04, 05 and 06 search for every caller and remove code and tests
  together; the daily app keeps running its shipped build until Ash ships the wave.
- **Native-only behaviour.** Browser specs can't see the native window. Any package touching windows, menus,
  Keychain, or the bundle keeps its dev-copy check open until done.
- **Licences.** Any vendored file goes through [SOURCES.md](SOURCES.md)'s rules.
