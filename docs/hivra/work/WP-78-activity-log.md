# WP-78: Activity log

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | M | none | yes |

## Goal

One plain list of the things agents and the app did that matter, so the person can always see who did what, when, and
who asked for it.

## Why

Orbit keeps an audit log of sensitive actions (restores, grants, admin changes; Apache-2.0). OpenBot stamps every
action with who started it. Hivra's agents merge, push, install plugins, drive browsers and desktops, and ship. Today
those traces are spread across chats and logs.

## Read first

- Orbit `apps/server/src/audit.rs` and where it is written (event names such as `backup.item_restored`), the Admin
  audit screen in `apps/web/src/features/admin/`.
- OpenBot's initiator-stamped audit (SOURCES.md), Hivra's delegations log, plugin install (WP-31), browser and desktop
  plugins (WP-43, WP-44), ship receipts (CLAUDE.md "Ship").

## Build

1. **A table and one function**: `activity::record(kind, actor, initiator, project, target, summary, link)`. Entries
   are append-only. The actor is the first mate, Mono, worker, the person or the app. The initiator is who asked
   for it.
2. **What is recorded**: merges, pushes and PRs opened by agents; plugin install, update, rollback and removal;
   browser and desktop control sessions starting and stopping; ships, trials, rollbacks; backups and restores
   (WP-75); trash and restore (WP-76); outside tools connecting and disconnecting (WP-79); permission and consent
   grants. Each call site gets the smallest hook. Wire up the ones that exist now; later packages add their own.
3. **Screen**: Settings → Activity. Newest first, filters by project, agent and kind, search, and each line links to
   the chat or item.
4. **Kept** 90 days by default. Included in Export. Never records secrets or message bodies, only summaries.

## Done when

- [ ] Tests: each listed action that exists today writes exactly one entry with the right actor and initiator;
      retention; no secret in a summary (the secret scan's patterns).
- [ ] Browser spec of the screen with seeded entries. Screenshot in the PR.
- [ ] `npm run check` passes.
