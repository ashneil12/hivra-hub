# WP-75: Checked backups, and restoring one thing

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | M | none | yes |

## Goal

Hivra backs itself up on a schedule and checks every backup. The person can bring back one lost chat, Mono, doc or
task from an old backup without rolling anything else back.

## Why

Ash is about to move his whole workflow onto Hivra. Today only a ship makes a backup. Orbit's backups are
scheduled and verified (checksums, retention) and can restore a single item into the live data (Apache-2.0).

## Read first

- Orbit `crates/platform/src/backup.rs` and `backup/reader.rs` (snapshot layout, manifest written last, checksum
  verification, read-only snapshot reading), `apps/server/src/repositories/backup_items.rs` and
  `backup_item_routes.rs` (one-item restore rules), `docs/operations.md` "Object storage (S3), backups and a lost
  server" and "Restore one page or one task".
- Hivra `src-tauri/src/ship.rs` and `scripts/hub-ship-runner.mjs` (how a ship backs up `monocode.db*` and `monos/`),
  Export and import (`docs/PORTABLE.md`, the secret scan), CLAUDE.md "Which copy is which".

## Build

1. **What a backup holds.** An online SQLite backup of `monocode.db` (never a file copy of a live database), the
   Monos folder, memory, and doc and note files. Never Keychain items or secrets. A `manifest.json` holds a SHA-256
   for every file and is written last, so a half-written backup is never mistaken for a whole one.
2. **Where.** A folder the person picks (default `<data>/backups/`). A synced folder such as iCloud Drive or Dropbox
   works as off-machine storage. S3 or R2 is a later package.
3. **When.** Off, hourly or daily (default daily). Keep the newest backup of each of the last 7 days and 4 weeks
   (Orbit's retention). "Back up now" in Settings → Backups. Each backup is verified after it is written, and
   Settings shows the last good one.
4. **Restore one thing.** Open a backup, pick a chat, Mono, doc or task, and copy it into the live app as a new item
   ("… (restored)"). Nothing else changes. The backup opens read-only and is verified first. A Mono restored this way
   keeps its soul and memory files.
5. **Restore everything.** It goes through the ship runner's existing restore path. The app quits, the database and
   Monos are put back, and the app reopens. It keeps a copy of the current data first.
6. **Dev copies.** Backups are off by default, write only to the slot's own folder, and never read the daily app's
   backups.

Translate Orbit's backup and verification code to Hivra's Rust (rusqlite), with its tests and credit.

## Done when

- [ ] Tests under a temporary HOME: a backup verifies; one flipped byte fails verification; retention keeps the
      right set; a chat, a Mono and a doc restore as new items and nothing else changes; a full restore puts the
      data back and keeps a copy of what it replaced; dev copies stay off.
- [ ] `npm run check` passes; a dev-copy check: restore a deleted chat from a backup.
