# MonoCode Hub — rules for agents working here

This repo is **Ash's MonoCode Hub fork**: his control centre and the runtime every project's agents work
through. It is built on upstream [MonoCode](https://github.com/hardbeat920/monocode) and must stay
mergeable with it.

Read this before building, installing or launching anything here.

## This repo is NOT upstream MonoCode

Two apps look almost identical on this Mac. Confusing them loses Ash's conversations.

| | This repo (`~/Projects/monocode-hub`) | Upstream (`~/Projects/monocode`) |
| --- | --- | --- |
| Bundle identifier | `com.ash.monocode-hub` | `com.monocode.desktop` |
| Product name | `MonoCode Hub` | `MonoCode` |
| Data directory | `~/Library/Application Support/com.ash.monocode-hub/` | `~/Library/Application Support/com.monocode.desktop/` |
| Who runs it | **Ash, daily** | nobody — upstream mirror only |

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
emitted `MonoCode.app` with upstream's identifier `com.monocode.desktop` — an app that opened upstream's
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

A dev copy can't reach Ash's real things: the Ash OS bridge is off unless `MONOCODE_HUB_PORT` and
`MONOCODE_HUB_TOKEN_FILE` point at the stub or the read-only proxy (never port 18767 or the live key), Keychain
names are `monocode-hub-dev:*`, and Claude runs with MCP servers and hooks stripped in
`~/.monocode-hub-dev/claude-config` (one Claude login for every dev copy; it refuses to start if that folder can't be
made). The orphan reaper, phone access, habits, automations, reminders, auto-resume, the notification prompt and
the quick composer's global shortcut are off. The app's own file commands won't open, move or remove the lock file. A DEV ribbon, the window title
(`MonoCode Hub Dev - <branch> @ <sha>`) and the Settings footer say which build is running.

**Never launch a build of this app with the real HOME to prove something.** To exercise a refusal or the lock, run
the binary with `HOME` set to a fresh temporary folder and `MONOCODE_NO_ALERT=1` (refusal on stderr only, same
exit code), and check that it used that folder.

## Before you build or launch — the checklist

1. **`npm run hub:check`** — runs `scripts/identity-guard.sh`. It fails if any Hub bundle carries the wrong
   identifier, if upstream's database has grown (a misidentified build ran), or if the Hub database shrank.
2. **`npm run hub:build`** — the only supported way to build this app. It passes the overlay config.
   Never run a bare `tauri build` here.
3. **`npm run hub:verify`** — asserts the built bundle's `CFBundleIdentifier` is `com.ash.monocode-hub` and that
   it carries a build stamp before anything installs it.
4. **`npm run hub:install`** — verifies, then installs to `~/Applications/MonoCode Hub.app`. It refuses to
   install a bundle that is not the Hub.

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
  without a busy timeout — the app holds it open.

## Upstream merges

`tauri.conf.json` is now Hub-owned, so an upstream merge conflicts on `productName`, `identifier`,
`beforeBuildCommand` and the window title. Re-apply them deterministically:

```bash
git fetch upstream && git checkout upstream/main -- src-tauri/tauri.conf.json
jq '.productName="MonoCode Hub" | .identifier="com.ash.monocode-hub"
  | .build.beforeBuildCommand="VITE_MONOCODE_HUB=1 npm run build"
  | .app.windows[0].title="MonoCode Hub"' src-tauri/tauri.conf.json > /tmp/t && mv /tmp/t src-tauri/tauri.conf.json
npm run hub:build && npm run hub:verify
```

## Development basics

- Work in a worktree or a branch; never edit the installed app in place.
- `npm run check` runs the web checks (`vitest run` + `tsc --noEmit`) and the Rust checks
  (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`). Run it before calling anything done.
- The hub flag `VITE_MONOCODE_HUB=1` is a **build-time** Vite variable (`src/features/hub/model/hubBundle.ts`,
  `IS_HUB_BUNDLE`). It is what makes the app open straight on the hub. Both `tauri.conf.json` and the overlay
  set it, so it is always on — in a build **and in dev** (`npm run hub:dev`; checked by
  `scripts/hub-dev-loop.test.cjs`, which fails if the dev command loses the flag).

### See a Hub change in the running app (the dev loop)

Never hand-build and re-install the app just to look at a frontend change. On this fork the frontend
is served from vite, so HMR applies it where it stands:

```bash
npm run hub:dev                   # this worktree's dev copy (tauri dev + HMR) in its own slot, invented Ash OS data
npm run hub:dev -- --hub live     # the same, reading the real Ash OS through the read-only proxy
npm run hub:dev -- --seed         # first copy a cleaned backup of the daily chats into the slot (opt-in)
npm run hub:dev -- --print        # which slot, port and config it would use; changes nothing
npm run hub:doctor                # the identity guard, then every bundle, data folder, running copy, slot and worktree
```

**Dev slots (`scripts/hub-dev.mjs`).** Every worktree runs its own dev copy, side by side with the others and with the
daily app. Its window says `MonoCode Hub Dev - <branch> @ <sha>` and carries a DEV ribbon.
- **Slot:** the worktree folder's name (`~/Worktrees/hub-x` → `hub-x`; `--slot hub/x` → `hub-x`). If a different
  worktree that still exists already has that name, a 4-character hash of this worktree's path is added. Remembered in
  `~/.monocode-hub-dev/slots.json`. The identifier is `com.ash.monocode-hub.dev.<slot>`, so the slot has its own data
  folder, WebKit storage and Dock entry (`MonoCode Hub Dev <slot>`); the daily identifier is never generated.
- **Port:** 1430 + 10 × (hash of the slot mod 50), the next free one in that grid if taken; never 1420. The generated
  `target/hub-dev/<slot>.conf.json` sets `devUrl` and `devCsp` (the base devCsp only allows 1420) and hands vite the
  port through `MONOCODE_VITE_PORT` in its own command.
- **Rust build cache:** `CARGO_BUILD_BUILD_DIR=~/Library/Caches/monocode-hub/cargo-build` (hub:dev and hub:build), shared
  by every worktree; each keeps its own `target/` for the final binary and bundle. Two builds at once wait for each other.
- **Ash OS:** the dev copy only talks to a server hub:dev starts on a free port: the stub (`--hub stub`, the default,
  invented data), the read-only live proxy (`--hub live`), or nothing (`--hub off`). Its token is a throwaway in
  `~/.monocode-hub-dev/slots/<slot>/`, never the live key.
- **Seed (`npm run hub:seed-dev`, or `hub:dev -- --seed`):** an online SQLite backup of the daily `monocode.db`, opened
  read-only, then in the copy only: in-flight turns, queued messages, the tab snapshot, pending worktree removals,
  automations, reminders, orchestration rows, delegation rows and every `provider_session_id` are cleared. It refuses the daily folder,
  a slot a running copy holds (its lock), a slot that already has chats (`--replace` moves them aside) and a source
  newer than the checkout's schema. It never writes back. Without a seed a slot starts empty.
- One copy per slot: starting a slot that is already running says so and exits 75.

- **Frontend change** (`src/**`): saves and appears in the open window within a second. No restart, no rebuild.
- **Rust change** (`src-tauri/**`): `tauri dev` recompiles and relaunches the app by itself; the window
  comes back with the change. Nothing to do by hand.
- **Anything Ash should keep using / that must survive a reboot:** that is a release build —
  `npm run hub:build && npm run hub:install`. Reserve it for a change that is finished, tested and landed.

Use `npm run dev` + a `hub-dev.html` page only for a browse-only look at the Hub's screens (stub or live
proxy). It has no Rust side, so `hub_call` needs the stub or the live proxy to answer.
- Backup app bundles (`~/Applications/MonoCode-Hub-backup-*`) are throwaway build snapshots. Check the
  identifier before trusting one — at least one was built before the identity fix and carries
  `com.monocode.desktop`.

## Signing (why the app kept asking for your password)

The hub was built **ad-hoc signed** (`signingIdentity: "-"`). An ad-hoc signature's designated
requirement is a bare `cdhash`, so **every rebuild produced a different app identity**. macOS keys two
things off that identity, and both broke on each rebuild:

1. **Keychain** — the model key (`monocode-hub:model-key`) is read when a session starts, so the
   "MonoCode Hub wants to use your confidential information" prompt came back after every rebuild,
   twice per fresh chat.
2. **Folder permissions (TCC)** — the Documents/Desktop/Downloads grants were discarded, so the
   "would like to access files in your Documents folder" prompt came back too.

The hub overlay now pins a real signing identity, so the requirement is
`identifier "com.ash.monocode-hub" and anchor apple generic and certificate leaf[subject.CN] = ...`
— stable across rebuilds. Permissions granted once now stick.

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


## Improvement loop and isolated test copy

For a reported bug, record the failure before changing it and keep every ask in a checklist. Work through:
**Reproduced → Changed → Checks passed → Delivered → Verified in app**.
A successful agent turn is not verification. Give exact check results and the app/revision exercised. If the native
window, provider or service cannot be exercised, report that gap and keep that acceptance step open.

To try a change in the app, use a dev copy (`npm run hub:dev`, see "Which copy is which"). It has its own data
folder, Mono files, webview storage and Keychain names, its live harness bridge is off and it never reaps the daily
app's processes. Do not copy the daily database or keys into it. Dev sessions still use the installed agent CLIs;
use a test worktree and avoid real external actions. The old MonoCode Test copy (`hub:test-copy:*`,
`com.ash.monocode-hub.sandbox`) is retired: dev copies replace it.

The real group and Pages paths use the normal selected Mono session engine. Stub/browser previews prove rendering
and controlled integration paths only; they do not prove a live provider, authentication or native release.
