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
and the dev-bundle constants in `src-tauri/src/macos.rs` match. There is no build path left that can emit
the upstream identifier. The scripts below keep it that way.

## Before you build or launch — the checklist

1. **`npm run hub:check`** — runs `scripts/identity-guard.sh`. It fails if any Hub bundle carries the wrong
   identifier, if upstream's database has grown (a misidentified build ran), or if the Hub database shrank.
2. **`npm run hub:build`** — the only supported way to build this app. It passes the overlay config.
   Never run a bare `tauri build` here.
3. **`npm run hub:verify`** — asserts the built bundle's `CFBundleIdentifier` is `com.ash.monocode-hub`
   before anything installs it.
4. **`npm run hub:install`** — verifies, then installs to `~/Applications/MonoCode Hub.app`. It refuses to
   install a bundle that is not the Hub.

Prove any bundle's identity at any time:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
  "$HOME/Applications/MonoCode Hub.app/Contents/Info.plist"
# must print: com.ash.monocode-hub
```

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
npm run hub:dev      # tauri dev with the Hub overlay: vite on :1420 + HMR, the app in a real window
```

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

`npm run hub:test-copy:build` creates **MonoCode Test.app**, identifier `com.ash.monocode-hub.sandbox`, compiled with
`test-copy`. `npm run hub:test-copy:verify` checks the bundle identity. It has its own app-data directory, Mono files,
webview storage and model-key service. Its live harness bridge is disabled and it never reaps daily-app processes.
The test feature and identity must match or startup refuses before touching app data. This is a **release build**;
its debug relaunch is intentionally refused because that path belongs to the daily app. Do not copy the daily database
or keys into it. Do not use `hub:install` for it. Open the verified bundle directly, or copy it beside the daily app
under its own name. Test sessions still use the installed agent CLIs; use a test worktree and avoid real external actions.

The real group and Pages paths use the normal selected Mono session engine. Stub/browser previews prove rendering
and controlled integration paths only; they do not prove a live provider, authentication or native release.
