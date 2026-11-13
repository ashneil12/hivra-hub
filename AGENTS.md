# MonoCode Hub: rules for agents working here

Every coding agent in this repo reads this file: Claude Code, Codex, OpenCode and any other CLI. `CLAUDE.md`
imports it and adds only what is specific to Claude Code, so a rule lives here once.

This repo is **Ash's MonoCode Hub fork**: his control centre and the runtime every project's agents work
through. It is built on upstream [MonoCode](https://github.com/hardbeat920/monocode) and must stay
mergeable with it.

Read this before building, installing or launching anything here. Building a Hivra work package? Start with
[docs/hivra/README.md](docs/hivra/README.md); every rule in this file still applies.

Changing anything a person sees? Read [docs/hivra/DESIGN.md](docs/hivra/DESIGN.md) first (the layout, the words, the
rules every screen keeps) and follow the `dropwave-ui` skill in `.agents/skills/`. To give the owner a new board or
tracker without changing the app, use the `make-a-hub` skill instead. What each screen calls is in
[docs/hivra/work/dropwave-wiring.md](docs/hivra/work/dropwave-wiring.md).

## This repo is NOT upstream MonoCode

Two apps look almost identical on this Mac. Confusing them loses Ash's conversations.

| | This repo (`~/Projects/monocode-hub`) | Upstream (`~/Projects/monocode`) |
| --- | --- | --- |
| Bundle identifier | `com.ash.monocode-hub` | `com.monocode.desktop` |
| Product name | `MonoCode Hub` | `MonoCode` |
| Data directory | `~/Library/Application Support/com.ash.monocode-hub/` | `~/Library/Application Support/com.monocode.desktop/` |
| Who runs it | **Ash, daily** | nobody. Upstream mirror only. |

`~/Projects/monocode` is the **read-only upstream mirror**. It exists to pull upstream changes into. Never
develop there, never install an app built from it, never launch it: its build is stored as "MonoCode" and
shares nothing with the Hub.

## The trap that already bit us (16 Oct 2026)

Tauri keys the data directory off the **bundle identifier**:

```
app_data_dir() = ~/Library/Application Support/<identifier>
```

The Hub's identity used to live only in `src-tauri/tauri.hub.conf.json`, a Tauri *overlay* that had to be
passed explicitly with `--config`. **No build script passed it.** So a plain `tauri build` in this repo
emitted `MonoCode.app` with upstream's identifier `com.monocode.desktop`, an app that opened upstream's
database. Ash's Hub session (a 1 MB conversation about this harness) looked like it had vanished; it had
simply been written to upstream's store instead.

**Fixed on 2026-10-16:** the identity now lives in `src-tauri/tauri.conf.json` itself (`productName`
`MonoCode Hub`, `identifier` `com.ash.monocode-hub`), the overlay is stripped to non-identity build deltas,
and the dev wrapper bundle (`src-tauri/src/macos.rs`) takes its identifier from the config and only ever wraps a dev
copy. There is no build path left that can emit the upstream identifier. The scripts below keep it that way.

## Which copy is which (Phase 1b, `src-tauri/src/instance.rs`)

The kind of copy comes from the identifier compiled into it:

| Identifier | Kind | Data folder | Runs from |
| --- | --- | --- | --- |
| `com.ash.monocode-hub` | **daily** (Ash's real chats) | `…/Application Support/com.ash.monocode-hub` | only `~/Applications/MonoCode Hub.app` |
| `com.ash.monocode-hub.dev.<slot>` | **dev copy** | `…/Application Support/com.ash.monocode-hub.dev.<slot>` | anywhere (`npm run hub:dev`) |

Checked at the top of `run()`, before any plugin or data access (the schema guard when the database opens). Each
refusal shows an alert and exits:
- any other identifier refuses to start (exit 78);
- a **debug build with the daily identifier refuses** ("use npm run hub:dev", exit 78);
- a daily build anywhere but `~/Applications/MonoCode Hub.app` refuses ("ship it", exit 78);
- **one app per data folder:** the running copy holds `<data>/instance-owner.sqlite` locked for its whole life and
  names itself in `<data>/running.json`; a second copy alerts with the owner and exits 75;
- a database written by a newer build is refused (exit 65).

A dev copy can't reach Ash's real things: it keeps its hub data (projects, Monos per project, Pages) in its own
database, its one-time Ash OS import reads only a stand-in a test names, never the live service, its key or its record
on disk, and
Keychain names are `monocode-hub-dev:*`. How it runs Claude is in [CLAUDE.md](CLAUDE.md) ("The dev copy's
Claude"). The PR watch (`src-tauri/src/pr_watch`) reads GitHub through
the user's `gh`, reads only; under a temporary HOME there is no gh login, and `MONOCODE_PR_WATCH_GH` (read by dev copies
only) points it at a stand-in. The orphan reaper, phone access, habits, automations, reminders, auto-resume, the notification prompt and
the quick composer's global shortcut are off. The app's own file commands won't open, move or remove the lock file. A DEV ribbon, the window title
(`Hivra Dev - <branch> @ <sha>`) and the Settings footer say which build is running.

**Never launch a build of this app with the real HOME to prove something.** To exercise a refusal or the lock, run
the binary with `HOME` set to a fresh temporary folder and `MONOCODE_NO_ALERT=1` (refusal on stderr only, same
exit code), and check that it used that folder. Under a temporary HOME the app sets `CFFIXED_USER_HOME` to it (Cocoa
ignores HOME, so the webview's storage, caches and preferences would otherwise land in the real home beside the daily
app's) and refuses to start if that didn't take; it also keeps off the Keychain's daily names, the orphan reaper,
phone access, the notification prompt and the global shortcut.

## Before you build or launch: the checklist

1. **`npm run hub:check`** runs `scripts/identity-guard.sh`. It fails if any Hub bundle carries the wrong
   identifier, if upstream's database has grown (a misidentified build ran), or if the Hub database shrank.
2. **`npm run hub:build`** is the only supported way to build this app. It passes the overlay config.
   Never run a bare `tauri build` here.
3. **`npm run hub:verify`** asserts the built bundle's `CFBundleIdentifier` is `com.ash.monocode-hub` and that
   it carries a build stamp before anything installs it.
4. **`npm run hub:check-all`** then **`npm run hub:ship`** installs into `~/Applications/MonoCode Hub.app`
   with a safety net (see "Ship" below). `npm run hub:install` is now only the one-time `--legacy` install of the
   first build that can ship (it keeps the old app under `~/Archive/monocode/ships/legacy-*`, never deletes it).

## Ship (Phase 1b WP3: `scripts/hub-ship.mjs`, `scripts/hub-ship-runner.mjs`, `src-tauri/src/ship.rs`)

From a clean commit: `npm run hub:check-all && npm run hub:build && npm run hub:ship`. A Lead inside the daily app
uses `app app.ship` instead (same code; its own running turn doesn't block the restart, and it resumes with the
receipt).

1. **Checks, before anything changes:** clean tree; the bundle's stamp is HEAD; a `hub:check-all` pass record
   (`target/hub-checks/<sha>.json`) for that commit; daily identity; a real signature (not ad hoc) matching the
   installed app's; the installed app can take a ship; disk space; `monocode healthcheck` on a copy of the live
   database. Any refusal leaves everything as it was.
2. **Stage:** `ditto` into `<data>/ship/<id>/staged/`, `state.json`, and the runner as a one-shot LaunchAgent
   (`com.ash.monocode-hub.ship.<id>`, outside the app's process group). Returns "scheduled" within seconds.
3. **The app** accepts the staged build only if its signature matches its own, then quits for the update when no
   other turn is running (or on **Restart now** at the top of the main pane; `whenBusy: "restart"` doesn't wait). Cut turns are saved
   for resume, marked with the ship.
4. **The runner** waits for the app's data-folder lock, backs up `monocode.db*` and `monos/`, renames the old app
   to `ship/<id>/previous.app.off`, moves the new one in and opens it ("trial").
5. **Trial:** the new build holds auto-resume, habits and automations until its window and database
   are up, then writes `committed.json`. Not in `running.json` within 30 s, no commit within 120 s, or an early
   exit: the runner stops that verified process, puts the old app and database copy back, and reopens it.
6. `receipt.json` and `runner.log` in the ship folder say what happened; the main pane shows it; the shipping Lead's
   resume note carries it. At startup the app finishes a trial or a restore a dead runner left.

After a commit, rollback is manual: `npm run hub:rollback -- <id> --confirm` (the database goes back to that
ship's copy, so newer chats leave the live database; the rollback keeps a copy of them). The last 3 ship folders
stay; older ones move to `~/Archive/monocode/ships/` and are never deleted (`npm run hub:doctor` shows how many and
how big). `npm run hub:ship -- --drill-rollback` runs the whole path
and then rolls back on purpose.

**Never** quit, kill (`pkill`, `killall`, `osascript ... quit`) or copy the daily app by hand, and never ship from
a dev slot's data: ship is the only way a build reaches `~/Applications`. Prove ship changes with a temporary HOME
(the tests in `scripts/hub-ship.test.mjs` do), never against the real app.

Prove any bundle's identity and build at any time, without launching it:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
  "$HOME/Applications/MonoCode Hub.app/Contents/Info.plist"
# must print: com.ash.monocode-hub
node scripts/verify-hub-bundle.mjs --stamp "$HOME/Applications/MonoCode Hub.app"
# the build stamp: {"sha","branch","dirty","builtAt"}, written by src-tauri/build.rs (readers: scripts/hub-bundle.mjs)
```

`…/Contents/MacOS/monocode version --json` prints the same stamp with the identity (no window, no data access), and
agents get it from `app app.version`. `monocode healthcheck [--db PATH]` migrates a copy of a database (the live
file is only read) and reports whether this build can open it.

## Conversations

- Ash's Hub conversations live in **`~/Library/Application Support/com.ash.monocode-hub/monocode.db`**
  (table `sessions`; `blocks_json` holds the transcript).
- The full raw transcript of every session is also in Claude Code's own store:
  `~/.claude/projects/<cwd-with-slashes-as-dashes>/<provider_session_id>.jsonl`.
- **Recovering a conversation that ended up in the wrong store:**
  `npm run hub:recover -- --dry-run` then `npm run hub:recover`. It copies `sessions` rows only, never
  overwrites, and backs up both databases first.
- **Never** copy the upstream database over the Hub's, and never edit a database while the app runs
  without a busy timeout, because the app holds it open.

## Upstream merges

`tauri.conf.json` is now Hub-owned, so an upstream merge conflicts on `productName`, `identifier`,
`beforeBuildCommand` and the window title. Re-apply them deterministically:

```bash
git fetch upstream && git checkout upstream/main -- src-tauri/tauri.conf.json
jq '.productName="MonoCode Hub" | .identifier="com.ash.monocode-hub"
  | .build.beforeBuildCommand="VITE_MONOCODE_HUB=1 npm run build"
  | .app.windows[0].title="Hivra"' src-tauri/tauri.conf.json > /tmp/t && mv /tmp/t src-tauri/tauri.conf.json
npm run hub:build && npm run hub:verify
```

A daily scheduled check watches upstream MonoCode and every borrowed-idea repo (`docs/hivra/upstream-watch.json`,
`node scripts/upstream-watch.mjs --state <file> --write`; it reads git only, never changes the checkout). When upstream
has commits main lacks, it opens the merge as a PR. Add a repo to that list whenever Ash shares one.

Hivra has one layout (WP-03, `src/features/hub/model/hivraLayout.ts`): Classic, fixed wherever the Hub flag is on.
Upstream's `tests/browser/layout-opt-in.spec.ts` tests the Classic/Focused switch Hivra doesn't have and was deleted
on purpose: when a merge brings it back (a modify/delete conflict), keep it deleted. Keep upstream's Focused code
itself; `src/features/hub/model/hivraLayout.test.ts` fails if a merge drops the hooks in `appearance.ts` or
`SettingsView.tsx`.

## Tests and handoff

- Put a test beside the code it covers: a web test is `src/**/*.test.ts` or `.test.tsx` next to its module, a
  script test lives in `scripts/` as `*.test.cjs` or `*.test.mjs`, and anything a person sees gets a browser spec in
  `tests/browser/`. Nothing new goes at the root of `tests/`.
- A web test never reaches the network beyond loopback and never writes into a real home data folder: the vitest
  setup file (`src/test/harnessSetup.ts`) fails it when it tries. A test that genuinely needs the network calls
  `allowNetworkForThisTest()` and says why in a comment.
- Before handoff, report the exact commands run, their result counts, skips and warnings, what could not be checked
  and why. Passing tests is not the same as verified in the app.
- Shipping guards (a fix needs a test, no silent skips, zero tests is not a pass, the escape ledger) are report-only
  scripts: `npm run check:guards`. They fail only with `--strict`, at the release pass. See
  [docs/hivra/shipping-guards.md](docs/hivra/shipping-guards.md).

## Development basics

- Work in a worktree or a branch; never edit the installed app in place.
- **Test what your change can reach, not everything (the default).** While you work and before you push, run
  `npm run check:affected`: the web and script tests whose imports reach a changed file (or that read one from disk),
  `tsc --noEmit` on everything, and the Rust check only when a change reaches it (`scripts/affected-tests.mjs`; it
  compares with `origin/main`, uncommitted edits included). A pull request's CI does the same. A change to
  `package.json`, the lockfile, a test, build or TypeScript config, the test setup, a `.d.ts` or CI itself runs every
  test, and so does every run that isn't a pull request.
- `npm run check` is the full suite: the web checks (`vitest run` + `tsc --noEmit`), the script tests
  (`node --test scripts/*.test.cjs scripts/*.test.mjs`) and the Rust checks (`cargo fmt --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test`). Main runs it after every merge and
  `hub:check-all` runs it before a ship; run it yourself only when the work asks for it (a dependency bump, a change
  to shared test setup, a release).
- The hub flag `VITE_MONOCODE_HUB=1` is a **build-time** Vite variable (`src/features/hub/model/hubBundle.ts`,
  `IS_HUB_BUNDLE`). It is what makes the app open straight on the hub. Both `tauri.conf.json` and the overlay
  set it, so it is always on: in a build **and in dev** (`npm run hub:dev`; checked by
  `scripts/hub-dev-loop.test.cjs`, which fails if the dev command loses the flag).

### See a Hub change in the running app (the dev loop)

Never hand-build and re-install the app just to look at a frontend change. On this fork the frontend
is served from vite, so HMR applies it where it stands:

```bash
npm run hub:dev                   # this worktree's dev copy (tauri dev + HMR) in its own slot
npm run hub:dev -- --seed         # first copy a cleaned backup of the daily chats into the slot (opt-in)
npm run hub:dev -- --print        # which slot, port and config it would use; changes nothing
npm run hub:doctor                # the identity guard, then every bundle, data folder, running copy, slot and worktree
npm run hub:clean                 # what a finished run left behind (stale slots, old configs, merged worktrees); removes nothing
npm run hub:clean -- --yes        # reap exactly that: no running copy, no uncommitted changes, never the daily app
npm run hub:clean -- --output-only --yes  # only rebuildable build output (target/ and the like); no worktree goes
```

**Dev slots (`scripts/hub-dev.mjs`).** Every worktree runs its own dev copy, side by side with the others and with the
daily app. Its window says `Hivra Dev - <branch> @ <sha>` and carries a DEV ribbon.
- **Slot:** the worktree folder's name (`~/Worktrees/hub-x` → `hub-x`; `--slot hub/x` → `hub-x`). If a different
  worktree that still exists already has that name, a 4-character hash of this worktree's path is added. Remembered in
  `~/.monocode-hub-dev/slots.json`. The identifier is `com.ash.monocode-hub.dev.<slot>`, so the slot has its own data
  folder, WebKit storage and Dock entry (`MonoCode Hub Dev <slot>`); the daily identifier is never generated.
- **Port:** 1430 + 10 × (hash of the slot mod 50), the next free one in that grid if taken; never 1420. The generated
  `target/hub-dev/<slot>.conf.json` sets `devUrl` and `devCsp` (the base devCsp only allows 1420) and hands vite the
  port through `MONOCODE_VITE_PORT` in its own command.
- **Rust build cache:** `CARGO_BUILD_BUILD_DIR=~/Library/Caches/monocode-hub/cargo-build` (hub:dev, hub:build and
  `npm run check:rust`), shared by every worktree; each keeps its own `target/` for the final binary and bundle. Two builds
  at once wait for each other. CI keeps its own `target/`; `MONOCODE_OWN_TARGET=1` does the same for one local run.
- **Disk floor:** `check:rust` and `hub:build` refuse to start (exit 75) under 30 GB free on the home volume
  (`scripts/disk-guard.mjs`; `MONOCODE_DISK_FLOOR_GB` changes it, 0 turns it off). On 10 Nov 2026 about 90 worktrees, each
  with its own 9-12 GB `target/`, filled the disk. `npm run hub:clean -- --yes` also clears the build output (`target/`,
  `src-tauri/target`, `test-results/`, `playwright-report/`, a real `node_modules`) of a worktree that is kept but clean
  and pushed; never a linked `node_modules`, a dirty or unpushed tree, or one something is running in.
- **Hub data:** the dev copy keeps it in its own database, like the daily app (no Ash OS; see "Ash OS is retired").
- **Seed (`npm run hub:seed-dev`, or `hub:dev -- --seed`):** an online SQLite backup of the daily `monocode.db`, opened
  read-only, then in the copy only: in-flight turns, queued messages, the tab snapshot, pending worktree removals,
  automations, reminders, orchestration rows, delegation rows, PR watches, the compare records (they name real worktrees) and every `provider_session_id` are cleared. It refuses the daily folder,
  a slot a running copy holds (its lock), a slot that already has chats (`--replace` moves them aside) and a source
  newer than the checkout's schema. It never writes back. Without a seed a slot starts empty.
- One copy per slot: starting a slot that is already running says so and exits 75.

- **Frontend change** (`src/**`): saves and appears in the open window within a second. No restart, no rebuild.
- **Rust change** (`src-tauri/**`): `tauri dev` recompiles and relaunches the app by itself; the window
  comes back with the change. Nothing to do by hand.
- **Anything Ash should keep using / that must survive a reboot:** that is a release build, shipped:
  `npm run hub:check-all && npm run hub:build && npm run hub:ship`. Reserve it for a change that is finished,
  tested and landed.

Use `npm run dev` + a `hub-dev.html` page only for a browse-only look at the Hub's screens (`?local` reads the local
store from the page's own localStorage, `monocode:dev-local-hub:<key>`). It has no Rust side.
- Backup app bundles (`~/Applications/MonoCode-Hub-backup-*`) are throwaway build snapshots. Check the
  identifier before trusting one: at least one was built before the identity fix and carries
  `com.monocode.desktop`.

## Project file and worktree clean-up (Phase 1b WP4)

- `.monocode/project.json` holds this repo's actions: **Setup** (`node scripts/setup-worktree.mjs`, runs after every
  `git worktree add`), **Run dev slot** (`npm run hub:dev`), **Check** (`npm run check`), **Ship** (`npm run hub:ship`).
  The app reads it only from the main checkout and runs nothing until Ash imports it in Settings > Worktrees; editing
  the file in a branch changes nothing. Agents use `app actions.list` / `app actions.run`.
- `scripts/setup-worktree.mjs` links `node_modules` from the main checkout when the lockfiles match (else `npm ci`) and
  links missing env files; it never replaces a real file and never writes through a link.
- Settings > Worktrees > Clean up reports every worktree in `~/Worktrees` (its size and how much of it is build
  output); nothing is removed without Ash's tap. `monocode worktrees-report` prints the same report read-only. Never
  delete a worktree or its `target/` by hand.
- **A finished worktree gives its build output back by itself** (`src-tauri/src/worktree_autoclean.rs`; the daily app
  only, a dev copy never runs it). Every 15 minutes, and 2 minutes after launch, it sweeps `~/Worktrees` and the
  worktrees the app knows (chats, PR watches). A worktree is **finished** when a pull request from its branch merged or
  closed with this exact commit as its head (the PR watch, else `gh pr list`, asked at most hourly per commit), or every
  delegated task in it is accepted and its commit is in the branch's upstream, or its branch is merged into the mainline
  with its commit on a remote. It must also be a linked worktree (never the main checkout) with an empty
  `git status`, nothing running in it (an agent, terminal, project action, chat turn, dev copy, a cargo build holding
  `.cargo-lock`, or any process of Ash's whose working folder is inside it, read with `lsof` just before the delete) and
  untouched for 10 minutes. When those working folders can't be read (lsof fails, or on Windows, which can't say) the
  sweep deletes nothing. Then only `target/`, `src-tauri/target/`, `test-results/`,
  `playwright-report/` and every `node_modules/` that is a real folder go (a linked `node_modules` stays), each only
  when git ignores it and tracks nothing in it. Each worktree is checked again under the removal reservation. The
  switch is Settings > Worktrees > "Clear build output of finished worktrees", on by default, kept in
  `<data>/worktree-autoclean.json` (a file it can't read means off).

## Signing (why the app kept asking for your password)

The hub was built **ad-hoc signed** (`signingIdentity: "-"`). An ad-hoc signature's designated
requirement is a bare `cdhash`, so **every rebuild produced a different app identity**. macOS keys two
things off that identity, and both broke on each rebuild:

1. **Keychain:** the model key (`monocode-hub:model-key`) is read when a session starts, so the
   "MonoCode Hub wants to use your confidential information" prompt came back after every rebuild,
   twice per fresh chat.
2. **Folder permissions (TCC):** the Documents/Desktop/Downloads grants were discarded, so the
   "would like to access files in your Documents folder" prompt came back too.

The hub overlay now pins a real signing identity, so the requirement is
`identifier "com.ash.monocode-hub" and anchor apple generic and certificate leaf[subject.CN] = ...`
and it is stable across rebuilds. Permissions granted once now stick.

`src-tauri/tauri.hub.conf.json` → `bundle.macOS.signingIdentity`. It is set to the local
"Apple Development: Ashneil Lanelle (JTBS9WU942)" certificate's SHA-1. If that certificate is ever
renewed or this repo moves to another Mac, update it:

```bash
security find-identity -v -p codesigning        # pick the Apple Development / Developer ID line
```

Then rebuild with `npm run hub:build`. To confirm the requirement is stable and not a hash:

```bash
codesign -d -r- "$HOME/Applications/MonoCode Hub.app"   # must NOT print a bare cdhash
```

Upstream CI passes its own `signingIdentity` through `tauri.release.conf.json`, so this does not change
packaged release builds.


## Restart-safe resume and the fake-Claude bench (Phase 1b WP5)

- A turn cut by a quit, crash or ship resumes by itself with a note naming the background work that was cut (ids
  included) and, for a ship, the receipt. It resumes at most 3 times in a row; then the chat shows a resume-stopped
  note (Needs you) and a waiting Lead hears it failed. A chat whose Claude transcript is gone starts fresh from its
  brief (a "recovered" note) instead of failing every message.
- **`npm run hub:verify-live`** proves the delegation chain through real restarts with a fake Claude
  (`scripts/fake-claude.mjs`): a throwaway dev slot under a temporary HOME, its projects and Ash's messages from the plan, `SIGKILL` between phases,
  `evidence/<run>/verdict.json`. `-- --fail-gate` is its negative control and must exit non-zero. It never touches the
  daily app, its data, `~/.claude` or a real Claude login; it runs in the background (no focus) and closes the copy at
  the end. Launch it for a final proof, not to iterate: the unit tests and `claudeFakeCli.test.ts` cover the parts.

## Improvement loop and isolated test copy

For a reported bug, record the failure before changing it and keep every ask in a checklist. Work through:
**Reproduced → Changed → Checks passed → Delivered → Verified in app**.
A successful agent turn is not verification. Give exact check results and the app/revision exercised. If the native
window, provider or service cannot be exercised, report that gap and keep that acceptance step open.

To try a change in the app, use a dev copy (`npm run hub:dev`, see "Which copy is which"). It has its own data
folder, Mono files, webview storage and Keychain names, its live harness bridge is off and it never reaps the daily
app's processes. Never copy the daily database or keys into it by hand: the one supported copy is
`npm run hub:seed-dev` (or `hub:dev -- --seed`), a cleaned backup of the chats only; keys never go in. Dev sessions
still use the installed agent CLIs; use a test worktree and avoid real external actions. The old MonoCode Test copy
(`hub:test-copy:*`, `com.ash.monocode-hub.sandbox`) is retired: dev copies replace it.

The real group and Pages paths use the normal selected Mono session engine. Stub/browser previews prove rendering
and controlled integration paths only; they do not prove a live provider, authentication or native release.

## Ash OS is retired (WP-04)

Hivra runs with no outside service. The Ash OS bridge (`hub.rs`, every `ash-hub-*` call, the change feed, the
`ash-os` MCP entry), its stubs, its read-only live proxy and `hub:dev --hub` are gone; the last commit that had them is
tagged `archive/ash-os-bridge`. What the app still needs lives in its own database (`src-tauri/src/local_hub.rs`,
table `hub_local_docs`; the webview's shapes in `src/features/hub/model/localHub/`): projects, which Monos work on which
project, and kept Pages (WP-33 takes Pages over). Being built reads the app's own open delegations; Needs, questions
and checks are empty until WP-14's decision store (`localHub/decisions.ts` is the seam). On a start after the change
the app asks Ash OS, read-only (`src-tauri/src/ash_os_import.rs`), and offers once to import its projects, memberships
and kept Pages. Only a sure answer is kept: no Ash OS on the Mac (no key file, or a dev copy with no stand-in) starts
clean for good; Ash OS not answering this time decides nothing and the next start tries again. Settings → Export and
import → "Bring over from Ash OS" runs it again at any time (it only adds). When the service gives nothing (it no longer
runs), the import reads Ash OS's record on disk instead (`ash_os_import/disk.rs`: the database and its log copied
into a private folder and only the copy opened, plus each strip project's `project.json`) and answers in the live
reads' shape; Ash OS's files are never written and nothing is made beside them. A dev copy reads only a stand-in
record named by `MONOCODE_ASHOS_DB` (and `MONOCODE_ASHOS_PROJECTS`), never the real one (the daily app ignores both). Every hub chat denies `mcp__ash-os`, so
Ash's own user-scope Ash OS server never loads in one. The local store's documents carry a revision: a window writes
only on top of the latest one and every window hears `local-hub://changed`.

## Export and import (Phase 5, docs/PORTABLE.md)

Settings → Export and import writes the whole setup (and, if ticked, the Ash OS memory and the workspace) to one
`.tar.gz` or a folder, and reads one back through a preview. Import only adds: imported Monos wait for Ash's OK,
connectors and model keys are entered again, automations come back paused, delegations come back as history. A chat
keeps the folder its file names only when it is inside a project this copy already has (links followed); otherwise it
has none, asks for one and starts nothing until then (`src-tauri/src/chat_folder.rs` refuses every launch without a
folder, never falling back to the home folder, `/` or the folder the app runs in). Secrets
never go in (one pattern list for the webview and Rust, then a final scan of the export). A dev copy keeps its memory in
its own data folder (`npm run hub:dev -- --memory <dir>` reads another one for Export) and never writes `~/agent-memory`.
