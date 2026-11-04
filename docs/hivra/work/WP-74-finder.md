# WP-74: Finder (one search box for everything)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | M | 70, 72 | yes |

## Goal

One keyboard shortcut (⌘K, Ctrl+K on Windows and Linux) opens a box that finds anything in Hivra: chats and their
messages, tasks, docs, Monos, projects, files and commands.

## Why

Ash, 4 Nov, after Orbit: "the finder feature". Orbit's ⌘K palette searches across the whole workspace. Hivra already
has most of the parts, spread out: the command palette (`FilePicker` in `>` mode), the search view
(`src/features/search/`, conversations, files and projects) and notes' mentions. This package joins them into one box.

## Read first

- Orbit `.ai/FEATURES.md` "Global shell" (the palette), its search and `TaskSearchBox`, `taskSearchTokens` tests, and
  `.ai/lessons.md` on the FTS5 integrity false positive with bundled SQLite.
- Hivra `src/features/search/model/appSearch.ts`, `src/features/files/ui/FilePicker.tsx`, `onOpenCommandPalette` in
  `App.tsx`, WP-70 and WP-72 stores.

## Build

1. **One box.** ⌘K opens it from anywhere. Typing searches every kind at once, with results grouped by kind, best
   first, and keyboard-first (arrows, Enter, ⌘Enter opens beside). `>` still lists commands, and a prefix narrows
   to one kind (for example `t:` for tasks, `d:` for docs).
2. **Index.** Tasks and docs get SQLite FTS5 tables kept in step with their stores. Chats keep their existing
   search. Results open in place: a task in its panel, a doc at the matching block, a message highlighted in its
   chat.
3. **Scope.** The current project ranks first; "All projects" is one key away.
4. Extend the existing palette and `appSearch` rather than adding a second one. Add `cmdk` only if the PR shows why
   the existing palette can't do it.

## Done when

- [ ] Tests: each kind is found and ranked; prefixes narrow; FTS stays in step after edits, moves and trash; the
      integrity check passes with the bundled SQLite.
- [ ] Browser spec: ⌘K finds a task, a doc, a Mono and a message, and opens each. Screenshot in the PR.
- [ ] `npm run check` passes.
