# WP-76: Trash

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | M | none | yes |

## Goal

Deleting a chat, Mono, project, doc, task or note moves it to the Trash for 30 days, and the person can put it back.

## Why

Mistakes shouldn't cost the person their work. Orbit trashes everything with a 30-day restore and puts the things
that went with it back too (Apache-2.0).

## Read first

- Orbit `.ai/FEATURES.md` (trash and restore of tasks, projects and pages; a trashed parent takes its subtree;
  restore brings back what went with it; a restored item under a trashed parent comes back at the top level).
- Hivra: how chats, Monos (soul and memory files on disk), projects and notes are deleted today. WP-70 and WP-72 add
  `trashed_at` to tasks and docs; use this package's module if it has merged, or add it in a follow-up if not.

## Build

1. **One trash module** (Rust, with a TypeScript model) that every kind uses: `trash(kind, id)`, `restore`,
   `delete_forever`, `empty`, and a daily purge of anything older than 30 days.
2. **Every delete goes through it.** Chats, Monos, projects, notes and docs, and tasks when WP-70 has merged. A
   Mono's files move to `<data>/trash/<id>/` instead of being deleted.
3. **Trashed things are gone everywhere else**: rails, search, Home, agents' tools and briefs.
4. **Cascade.** A trashed project takes its chats, tasks and docs; restoring it brings back what went with it, not
   what was trashed separately before.
5. **Safety.** A chat with a running turn can't be trashed until it stops. A trashed Mono's running work is
   cancelled first, and the person is told.
6. **Trash screen** in Settings (or the rail's menu): items by kind, Restore, Delete forever, Empty trash.

## Done when

- [ ] Tests for every kind: trash, restore, cascade, purge at 30 days with a fake clock, Mono files moved and put
      back, and a running chat refused.
- [ ] Browser spec: delete a chat, find it in Trash, restore it. Screenshot in the PR.
- [ ] `npm run check` passes.
