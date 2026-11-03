# WP-07: Rename the app to Hivra

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D | M | 06 | no |

## Goal

The app is called Hivra everywhere a person sees a name, and (once Ash agrees the new identifier) its data moves
safely to the new identity.

## Why

The product is Hivra. But the bundle identifier decides the data folder (CLAUDE.md, "The trap that already bit
us"), so a careless rename loses Ash's chats. This package does it in two gated steps.

## Read first

- CLAUDE.md in full (identity, ship, dev slots, Keychain names).
- `src-tauri/tauri.conf.json`, `src-tauri/tauri.hub.conf.json`, `src-tauri/src/instance.rs`,
  `src-tauri/src/hub_keychain.rs`, `scripts/identity-guard.sh`, `scripts/hub-ship*.mjs`, `scripts/hub-dev.mjs`,
  `scripts/verify-hub-bundle.mjs`.

## Build

1. **Step 1, display names only** (no data moves): product name, window title, menus, About, onboarding, docs and
   the DEV ribbon say Hivra. The identifier, data folder, Keychain names and the installed bundle path stay as they
   are. Update CLAUDE.md and every script that matches on names in the same PR.
2. **Step 2, the identifier** (only after Ash confirms the new identifier in the PR): a migration that, on first
   start of the renamed app, copies (never moves) the old data folder, Keychain entries and Mono home to the new
   identity, checks the copy with `monocode healthcheck`, and leaves the old folder untouched as a backup. Ship
   installs the renamed bundle and keeps the old one as `previous.app.off`, so rollback still works. Dev slot
   identifiers follow the new prefix.
3. Prove both steps under a temporary HOME with a seeded data folder (the ship tests show how).

## Don't

- Don't change the identifier without Ash's written OK in the PR.
- Don't delete the old data folder or Keychain entries, ever.

## Done when

- [ ] Step 1: no "MonoCode Hub" left in anything a person sees; identity guard, ship and dev-slot tests pass.
- [ ] Step 2: the migration test copies a seeded data folder, the new app opens it, the old one is unchanged, and
      a ship rollback restores the old app.
- [ ] `npm run check` and `npm run hub:check-all` pass.
