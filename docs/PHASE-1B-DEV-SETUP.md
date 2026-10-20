# Phase 1b design: one daily app, isolated dev copies, one safe Ship

Written 19 Oct 2026 by a read-only design pass over hub/next, upstream v0.16 and T3 Code. Build from this; Ash's words and `docs/HUB-PLAN.md` win over it.


This is a plan only; I changed nothing. Cut every package from `hub/next` once Phase 1 lands. Upstream v0.16 rewrote `lib.rs` and `macos.rs`, so `docs/hub-plan` would conflict twice.

## 1. Target design

| | Daily app | Dev copy ("slot") |
|---|---|---|
| Identifier | `com.ash.monocode-hub` | `com.ash.monocode-hub.dev.<slot>` (slot = worktree folder name; a 4-character path hash is added only on a clash) |
| Window | MonoCode Hub | "MonoCode Hub Dev - <branch> @ <sha>" with a DEV ribbon |
| Data folder | `~/Library/Application Support/com.ash.monocode-hub` | `…/com.ash.monocode-hub.dev.<slot>` (its own browser storage and settings too) |
| Port | none | 1430 + 10 × (hash mod 50); the next free one if taken |

**Three rules, checked at the top of `run()` before any plugin or data access:**
- The kind of copy comes from the identifier compiled into it. Anything else refuses to start.
- A debug build with the daily identifier refuses, with "use npm run hub:dev".
- The daily app runs only from `~/Applications/MonoCode Hub.app`. A daily-identity build anywhere else says "ship it" and exits.

**What a dev copy can't do.** Continuation-06's compile-time `test-copy` checks become runtime checks on the copy's kind:
- The Ash OS bridge is off, or points at the stub server or the read-only live proxy. Port 18767 is refused.
- Keychain names become `monocode-hub-dev:*`, so a dev copy can never ask for a daily key.
- Claude runs with MCP servers and hooks stripped, using one shared `CLAUDE_CONFIG_DIR=~/.monocode-hub-dev/claude-config`. That means one login covers every slot.
- Switched off: the orphan reaper, v0.16 phone access (port 38416 + UPnP), habits, automations, reminders, auto-resume and the notification prompt.
- "MonoCode Test" retires into this.

**One app per data folder.** At startup the app takes an exclusive SQLite transaction on `<data>/instance-owner.sqlite` (no busy wait, retried for 2 s) and holds it for its whole life. The OS releases it even after a hard kill, and the file is never deleted. Beside it, `running.json` records `{pid, startTime, kind, sha, branch, bundlePath}`. A second copy shows an alert naming the owner and exits with code 75. A schema guard refuses a database newer than the build.

**Build stamp and inventory.**
- `build.rs` embeds `MONOCODE-STAMP:{sha,branch,dirty,builtAt}`, readable from any bundle without launching it.
- The stamp shows in the Settings footer and the dev window title. `monocode version --json` and an `app.version` command return it.
- `hub:doctor` runs the identity guard, then lists every bundle, data folder, running copy, slot and worktree with commit, kind and size.

**Ship.** `npm run hub:ship`, the Ship button and a Lead all use the same code.
1. **Checks before anything changes:**
   - the tree is clean and the stamp's commit equals HEAD;
   - `hub:check-all` has a pass record for that commit;
   - the identity is right and the signature isn't ad-hoc;
   - there is enough disk;
   - `monocode healthcheck` migrates a backup copy of the live database, with no window.
2. **Stage.** Copy the bundle with `ditto` into `<data>/ship/<id>/` and write `state.json` as "staged". Start a separate runner as a one-shot LaunchAgent. It sits outside the app's process group, so the app's quit, which kills its agents' process groups, can't kill it.
3. **Quit for update.** The app accepts the staged build only if its signature matches the app's own. It quits when idle: no other running turns, autopilot on, or Ash taps "Restart now". This is the normal quit path without the "chats still running" dialog. Running turns, including the shipping Lead's, are saved for resume and marked `update:<id>`.
4. **Swap.** The runner:
   - waits for the recorded process (pid + start time) to exit;
   - copies the database files and `monos/`;
   - renames the old app to `ship/<id>/previous.app.off` (it can't be launched), and the staged build into place;
   - sets the state to "trial" and opens the app.
5. **Trial.** The new build holds auto-resume, habits and automations. Once the window, database and hub bridge are up, it writes "committed" and releases them.
6. **Automatic rollback.** If the new commit isn't in `running.json` after 30 s, there's no "committed" after 120 s, or the app exits first, the runner:
   - stops that verified process;
   - renames the old app back and restores the database copy;
   - reopens the old app and records "rolled back" with the reason.
7. **Receipt.** The runner writes `receipt.json` and `runner.log`. Whichever build boots shows the result in Today and adds it to the shipping Lead's resume note.

**When the shipping chat is inside the app being replaced:** `hub:ship` returns "scheduled" within seconds. The Lead's turn is then cut by the quit, as expected. The Lead never waits on the swap and never kills anything. Auto-resume wakes it once in whichever build ends up running, with the receipt.

**Rollback rules:**
- Rollback is automatic only before "committed".
- At startup, `main()` finishes an interrupted trial or restore if the runner died (crash, reboot).
- After "committed", the new build is authoritative. A crash loop hits the three-try cap. `hub:rollback <id>` is manual, because the database copy would drop newer chats.
- Only the last 3 ship folders stay; older ones move to `~/Archive/monocode/ships/`. Nothing deletes them;
  `hub:doctor` reports the archive's count and size.
- Ash installs the first build that can ship once, with the old `hub:install`.

## 2. Work packages

**WP1: identity, lock, stamp (first)**
- **Files:**
  - New: `src-tauri/src/instance.rs`, `src/app/shell/DevRibbon.tsx`.
  - Change: `lib.rs`, `main.rs` (`version`, `healthcheck`), `build.rs`.
  - Change: `macos.rs` (dev identifier from config; signs with the dev certificate).
  - Change: `hub.rs`, `hub_keychain.rs`, `model_router.rs`, `harness.rs`.
  - Change: `session_store.rs` (schema version, migrate-only for the healthcheck), `SettingsView.tsx`, `identity-guard.sh`, `verify-hub-bundle.mjs`.
  - Delete: `tauri.test-copy.conf.json`, `verify-test-copy.mjs`, the `test-copy` feature.
- **Tests:**
  - Rust unit tests: kind table, debug build refused, second lock is busy and freed on drop, dev never forms a daily Keychain name, continuation-06's MCP/hooks test, schema guard, stamp parse.
  - Script test: `scripts/identity-guard.test.cjs` on fixture bundles.
- **Verify:** `npm run check && npm run hub:build && npm run hub:verify`, then open the `target/release` bundle → alert and exit 75. `"…/MacOS/monocode" version --json` prints the stamp.
  - *As built (WP1):* the location rule runs before the lock, so the `target/release` bundle itself refuses with exit 78 ("ship it"); exit 75 comes from a copy at `~/Applications/MonoCode Hub.app` while another copy holds the lock. Prove both with `HOME` set to a temporary folder and `MONOCODE_NO_ALERT=1`, never the real HOME.

**WP2: dev slots, seed copy, doctor**
- **Files:**
  - New: `scripts/hub-dev.mjs`, `scripts/hub-seed-dev.mjs`, `scripts/hub-doctor.mjs`.
  - Change: `vite.config.ts` (port from env), `package.json`, `hub-dev-loop.test.cjs`, `hub-live-proxy.mjs`.
  - `hub-dev.mjs` handles the slot name, port probe and a generated `target/hub-dev/<slot>.conf.json`. That file sets `devUrl` and `devCsp`, because the base CSP hardcodes port 1420.
  - It also sets `CARGO_BUILD_BUILD_DIR=~/Library/Caches/monocode-hub/cargo-build`, a shared Rust cache.
  - The seed is opt-in. It backs up the live database online, then clears in-flight turns, automations, reminders, orchestration rows and `provider_session_id`. It refuses the daily folder or a locked one, and never writes back.
- **Tests (`node --test`):** slot names (branches with `/`, clashes), busy-port probe, CSP carries the slot port and not 1420, identifier never daily, seed refusals, doctor on a fixture tree.
- **Verify:** `npm run hub:dev` in two worktrees at once → two titled windows with ribbons. `npm run hub:check` shows the daily session count unchanged. `npm run hub:doctor`. `hub:build` still finds its bundle with the shared cache set.
  - *As built (WP2):* the slot registry is `~/.monocode-hub-dev/slots.json`; a clash is also found from a slot's `running.json` when the registry has lost it. vite reads `MONOCODE_VITE_PORT`, put in the slot's own `beforeDevCommand` so the dev copy's terminals don't inherit it. Each slot's dev wrapper is `target/debug/MonoCode Hub Dev <slot>.app` (`MONOCODE_DEV_APP_NAME`). The Ash OS bridge is the stub by default (`--hub live` for the read-only proxy, `--hub off`), started in-process on a free port with a throwaway token; the proxy now takes the live key from `--key-file`, never `MONOCODE_HUB_TOKEN_FILE`, and with `--client-token-file` answers only that token. `hub:build` sets the shared cache too. The seed also clears the tab snapshot, pending worktree removals and queued messages, refuses a source newer than the checkout's schema, and records `seeded.json`. Tests: `scripts/hub-dev-loop.test.cjs`, `hub-seed-dev.test.cjs`, `hub-doctor.test.cjs`.

**WP3: Ship**
- **Files:**
  - New: `scripts/hub-ship.mjs`, `scripts/hub-ship-runner.mjs` (plain Node, absolute paths), `scripts/hub-rollback.mjs`.
  - New: `src-tauri/src/ship.rs` (state machine, early `main()` check, watching `state.json`, commit, handoff).
  - Change: `window.rs` (quit for update), `appLifecycle.ts`, `App.tsx` (auto-resume waits for "committed"), `agentApp.ts` (`app.version`, `app.ship`).
  - Change: `package.json` (`hub:check-all` writes `target/hub-checks/<sha>.json`; `hub:ship`, `hub:rollback`; `hub:install` becomes the one-time `--legacy` path).
- **Tests:**
  - Rust: state transitions, including a restart mid-restore.
  - `scripts/hub-ship.test.mjs` in a temporary HOME with a fake bundle: commit; no commit rolls back and the database matches byte for byte; crash mid-swap; refusals (dirty tree, commit mismatch, wrong identity, ad-hoc signature).
- **Verify:**
  - From a Lead inside the daily app: commit a visible change, then `npm run hub:check-all && npm run hub:build && npm run hub:ship`. The app comes back on the new commit and the Lead resumes with the receipt.
  - Then `npm run hub:ship -- --drill-rollback` → the old commit is back and `shasum` of `monocode.db` equals the copy.
  - *As built (WP3):*
    - One lock rule everywhere: `<id>/runner.lock` is the same exclusive SQLite lock as the instance lock, and only its
      holder writes `state.json` (the runner, or the app at startup when the runner is gone). The apps leave their own
      notes beside it: `accepted.json`/`refused.json` (old app), `committed.json` (new build). The runner "waits for
      the app to exit" by taking the data folder's instance lock, which it holds through the swap and the restore.
    - The LaunchAgent restarts a crashed runner (`KeepAlive.SuccessfulExit = false`) and every step is recorded, so
      it carries on; `ship.rs::plan` is the startup side of the same table (unit-tested, with a restart mid-restore).
    - Under a temporary HOME the app sets `CFFIXED_USER_HOME` (Cocoa ignores HOME) and keeps off system-wide things;
      the runner opens the app directly with that HOME (Launch Services would use the real one) and the LaunchAgent
      label is `test.monocode-hub-ship.<id>`. That is how the drill runs without touching the daily app.
    - `whenBusy: "restart"` (and Restart now) quit even with turns running. Autopilot (`src-tauri/src/autopilot.rs`)
      never ships by itself: whoever calls `app.ship` chooses `whenBusy`, and autopilot's crash relauncher leaves a
      ship in progress alone.
    - `hub:rollback <id> --confirm` is itself a ship (kind `rollback`): it backs up the current database first, so it
      can be rolled back too.

**WP4: project file and worktree janitor**
- **Files:**
  - New: `.monocode/project.json` with Setup, Run dev slot, Check and Ship actions.
  - New: `scripts/setup-worktree.mjs`. It links `node_modules` when the lockfile matches the main checkout, otherwise runs `npm ci`, and links env files only when missing.
  - New: `src-tauri/src/project_file.rs`, which reads only the main checkout's copy, after one explicit import.
  - New: `src-tauri/src/worktree_janitor.rs`, a report-only verdict function.
  - Change: `worktrees.rs` (setup runs after `git worktree add`), `agentApp.ts` (`actions.list` and `actions.run`), `WorktreesPage.tsx`.
- **Tests:** verdict cases ported from T3's `storageCleanup.ts`; schema; setup in a temporary repo (never replaces a real `.env`, never follows symlinks).
- **Verify:** create a worktree in the app → the setup log shows before the first turn. Settings > Worktrees lists `~/Worktrees` (43 GB) and removes nothing.
  - *As built (WP4):* the format is general (`version`, `actions[{id, name, command, icon, runOnWorktreeCreate, hold, longRunning, timeoutSeconds, confirm}]`, `worktrees.buildOutput`; unknown fields are errors). The import stores the exact text Ash reviewed in the copy's `project-files.json` and every run uses that copy, so an edited file shows "changed" and runs nothing new until re-imported. Runs live in `src-tauri/src/project_actions.rs`: own process group, log in `<data>/action-runs/`, `project-action` events, a timeout unless long-running, all stopped when the app exits; only in the main checkout or a registered worktree. Setup starts in `git_worktree_create` (and orchestration worktrees) and the chat holds its first turn on `worktreePreparing`, showing the run as a shell step; a failed setup lets the turn start with a warning. Agents get `actions.list`, `actions.run` and `worktrees.create {runSetup}`; there is no agent route to the import. The janitor only reads (`GIT_OPTIONAL_LOCKS=0`, no fetch, `lstat` walks); "Free build output" deletes only folders git ignores and tracks nothing in, "Remove" re-checks each worktree and then goes through the app's own removal so chats are detached, never deleted. `monocode worktrees-report [--root PATH] [--json] [--no-pr]` prints the report with no window and no app data. `.gitignore` gains `/node_modules` so a linked node_modules isn't an untracked file. *Fixed in WP5:* "merged" is checked against the repository's real mainline, not `origin/HEAD` (here an old `origin/hub-frontend`): the project file's optional `mainBranch` (the local branch, else `origin/<name>`), else the branch the main checkout has checked out (`pm/pages-live`), else the remote's default; the merged pull request check targets that branch.

**WP5: restart-safe resume and fake-Claude test bench**
- **Files:**
  - Change: `session_store.rs` (save the background-task list and a retry counter).
  - Change: `inFlight.ts` (a bounded "what was cut" note that includes the ship receipt; after 3 tries the chat goes to Needs you).
  - Change: `claude.ts` ("No conversation found" starts fresh from the brief).
  - New: `scripts/fake-claude.mjs` and `scripts/hub-verify-live.mjs`. The latter uses a throwaway slot, writes `evidence/<run>/verdict.json`, and has a `--fail-gate` negative check.
  - Copy T3's 18 recorded Claude fixtures with their MIT notice.
- **Tests:** fixture replay, the three-try cap, note limits, recovery of a dead Claude session.
- **Verify:** `npm run hub:verify-live` passes and `-- --fail-gate` exits non-zero. In a ship drill, a Lead cut mid-turn resumes once, with the note.
  - *As built (WP5):*
    - **What was cut.** `claude.ts` reports every background task with its id (`background.work`) whenever the roster changes; the session keeps it as `cutWork` and `in_flight_sessions` gains `background_json` and `resumes` (added in place, not a numbered migration, so a rolled-back build still opens the database). An automatic resume opens with a bounded note (at most 10 entries of 160 characters, ids kept whole, "and N more"), before the plain continue or a ship's receipt (`inFlight.ts` `resumePrompt`). The note rides forward until Claude has the resumed prompt.
    - **Three tries.** Every automatic resume is counted (`autoResumes`, saved in the row); any other turn starts again from none. At three the chat stops: a `resume-stopped` note (Needs you for a Mono, "input" on a delegated worker's card), the row is dropped (`session_drop_in_flight`) so the next boot doesn't mark it interrupted again, and an open H2 row is settled as failed so the Lead hears why. A question on screen is never resumed over. H2's `resumeMonitor` takes the resume flag from the caller, since a resume's text is no longer the bare continue.
    - **Dead sessions.** Claude Code 2.1.302 answers `--resume` of a missing transcript with a no-turn error result ("No conversation found with session ID") and exits 1 (recorded under a scratch HOME: `fixtures/claude-cli-2.1.302/no-conversation-found.ndjson`). The adapter drops the id (`session.providerLost`, a "recovered" note) and runs the turn once more in a fresh conversation whose first prompt is the chat's deterministic brief (`wrapRecoveredPrompt`); a failure there is real. A Mono's soul and memory are handed over again. There is no `/goal` to re-issue yet.
    - **Bench.** `scripts/fake-claude.mjs` is a stream-json fake (rules or a recorded transcript; conversations on disk so `--resume` works across restarts and a deleted one answers like 2.1.302; `monocode app` calls go straight to `MONOCODE_APP_ENDPOINT`). `scripts/hub-verify-live.mjs` builds the slot `<worktree>-verify` with `cargo build` (the slot config in `TAURI_CONFIG`), serves vite itself, and runs `target/debug/monocode` under a temporary HOME with `MONOCODE_VERIFY_LIVE=<plan>` (read only by a dev copy under a temporary HOME: `src-tauri/src/verify_live.rs`; fake Claude binary, auto-resume on, a kickoff Mono) and `MONOCODE_HUB_BACKGROUND=1` (never takes focus). It kills the app with SIGKILL between phases and writes `evidence/<run>/verdict.json`, the fake's events and prompts, each launch's log and the database. Its last launch runs double delegation on a second plan: the stub lists a `verify` project on the scratch folder (so the hub makes its Lead and ties the team to it) and the kickoff opens the built-in Chief of Staff (`kickoff.monoId`), which briefs that Lead with `delegate_task {lead}`. `question_routed`: the Lead's worker asks (AskUserQuestion, the fake's `ask` step), the Lead gets the `[MonoCode question]` turn (Chief of Staff gets none, Ash's Waiting on you marks it routed to the Lead), answers with `task_answer`, and the worker's same turn goes on with the answer. `cascade_stop`: Chief of Staff's `task_cancel` on its brief cancels the brief's row and the row of the Lead's second worker (both disposed), interrupts that worker, leaves the Lead's own turn running, and no report follows. Then a third plan (`goals: true`: the fake keeps `/goal` the way 2.1.302 does, `--resume` keeps it, a fresh conversation doesn't) restarts the app with two goal workers, the Lead and three waiting briefs busy, and worker B's transcript deleted: `goal_survives_restart`, `queued_brief_after_restart`, `cancelled_brief_stays_out`, then one more restart for `nothing_repeats_after_restart`.
    - **Replay.** T3 Code's 18 Claude transcripts (MIT, notice in `fixtures/t3code/LICENSE`) replay through the live adapter (`claudeFixtureReplay.test.ts`, parser `scripts/claude-fixtures.mjs`). One adapter gap is written down there: a background wake Claude runs before a queued prompt ends the MonoCode turn.
    - Also: sessions.start and models.list wait for the first harness probe, so a Lead resumed right after a restart isn't told its harness "is not available".

**Order:** WP1 first. Then WP2, WP3 and WP4 run in parallel. They share only separate `package.json` script keys, plus one line each from WP3 and WP4 in `agentApp.ts`; both are trivial rebases. WP5 waits for WP3, because both edit the auto-resume in `App.tsx` and `inFlight.ts`.

## 3. Risks

- **Keychain:** a dev copy never names a daily Keychain item. Ad-hoc signatures change on every rebuild and re-prompt, so dev bundles are signed with the Apple Development certificate under the slot's identifier.
- **Folder permissions (TCC):** at most one prompt per slot, and only for protected folders; the projects live in `~/Projects`. Dev copies skip the notification permission prompt.
- **Claude login:** a custom config folder gets its own Keychain login (`Claude Code-credentials-<hash>`; two already exist on this Mac). That's why all slots share one folder. Never `~/.claude`: a seeded slot would resume Ash's real transcripts.
- **Port clashes:** ports are hashed and probed, vite fails loudly on a clash, and each slot gets its own CSP. The app's control endpoint already picks a free port.
- **SQLite locks:** the lock is its own file. Seeds use SQLite's online backup. Ship copies the database only after the daily process has exited. The healthcheck touches a copy. Guards read in read-only mode.
- **Shared Rust cache:** each worktree keeps its own `target/`, so builds never overwrite each other's app. The shared `build-dir` setting is stable since cargo 1.91; this Mac has 1.94. Builds running at the same time wait for each other.
- **The app killing itself:** the runner lives under launchd and only signals processes it has verified. Rules go into `CLAUDE.md` and the Hub Lead's soul:
  - no `pkill` or `killall`;
  - no `osascript quit`;
  - no copying bundles by hand;
  - dev slots only.
- **Old build on a migrated database:** the schema guard refuses it, and the previous bundle can't be launched.

## 4. Cleanup

Run `hub:doctor` first. Each action is a move into `~/Archive/monocode/1b-<date>/`, done only with Ash's OK. Nothing is deleted.

1. `~/Applications/MonoCode Hub.app` (daily, com.ash.monocode-hub, 0.13.0): keep.
2. **Backup bundles:** none are left in `~/Applications`. The 16 Oct cleanup already zipped 9 into `~/Archive/monocode/stale-apps-20261016T220025` (151 MB). Keep them and add a README.
3. **`MonoCode Test.app` and continuation-06's own `MonoCode Hub.app` build**, both in `~/Worktrees/monocode-hub-continuation-06/target/release/bundle/macos/`:
   - MonoCode Test (com.ash.monocode-hub.sandbox) was never launched and has no data folder.
   - The `MonoCode Hub.app` build there carries the daily identity and can be launched.
   - Zip both to the archive.
4. **`/Applications/MonoCode.app`** is already gone; its zip `monocode--app-upstream-identity--removed-20261016.zip` stays in the archive. Also move `~/Downloads/MonoCode.dmg`, the upstream installer.
5. **`~/Library/Application Support/com.monocode.desktop` (3.2 MB):**
   - I checked by session id today: all 6 of its conversations are already in the Hub database, with transcripts as long or longer.
   - Run an integrity check and a backup, then move the folder and its WebKit, Caches, Preferences and Logs leftovers.
   - The guard then treats it missing as OK and it reappearing as a failure.
6. `~/Library/{WebKit,Caches}/com.ash.monocode-hub-proof`, from an old proof identity: move.
7. **Build output:** the `target/` folders in monocode-hub (8.8 GB), continuation-06 (13 GB) and monocode-hub-next (5.9 GB). The janitor removes build output only, with Ash's OK.
8. Keep `~/Projects/monocode` (the upstream mirror) and the Claude Keychain logins.

### Critical Files for Implementation
- /Users/ash/Projects/monocode-hub/src-tauri/src/lib.rs (new `instance.rs` beside it)
- /Users/ash/Projects/monocode-hub/src-tauri/src/macos.rs
- /Users/ash/Projects/monocode-hub/src-tauri/src/window.rs
- /Users/ash/Projects/monocode-hub/package.json (new `scripts/hub-dev.mjs`, `scripts/hub-ship.mjs`, `scripts/hub-ship-runner.mjs`)
- /Users/ash/Projects/monocode-hub/src-tauri/src/session_store.rs
