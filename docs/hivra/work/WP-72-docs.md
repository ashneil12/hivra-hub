# WP-72: Docs

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | L | none | yes |

## Goal

Notes grow into docs: a page tree with a block editor, version history, and links to tasks, chats and other pages.
Agents can read and write them too.

## Why

Ash, 4 Nov: Orbit's docs are "actually great". Hivra already has notes (`src-tauri/src/notes.rs`,
`src/features/notes/`): Markdown with tags and `note/` mentions. Keep them and make them better. Don't build a second
store.

## Read first

- Orbit `packages/editor/` (its BlockNote setup, slash menu, Callout and Mermaid blocks, mentions, Markdown import and
  export), `apps/server/src/repositories/pages.rs`, `page_versions.rs`, `page_mentions.rs`, `page_export.rs`,
  `apps/server/src/collab/markdown_import.rs`, `apps/web/src/features/docs/`, `.ai/FEATURES.md` "Docs".
- Hivra notes (store, mentions, images, `noteImages.ts`), the Pages and panels work (WP-33: Pages are dashboards,
  docs are writing; keep them apart).

## Build

1. **Store.** Notes gain a parent (a page tree), an order, `blocks_json` beside the Markdown `body` (Orbit keeps
   both: the blocks for the editor, Markdown for search, agents and export), a version counter and `trashed_at`.
   Existing notes migrate in place: their Markdown becomes blocks on first open, and nothing is lost if that fails.
2. **Editor.** BlockNote (`@blocknote/core` and `@blocknote/react`, MPL-2.0, as npm dependencies). Never the
   BlockNote XL packages (GPL or commercial). Slash menu, headings, lists, checklists, code, quotes, callouts,
   images and files (stored as notes' images are now), Mermaid. `@` mentions of pages, tasks (WP-70 when merged),
   chats and Monos.
3. **Versions.** A version is saved when the editor goes idle or the page closes, and on every agent edit, marked
   with who made it. A history panel shows them, and restoring one makes a new version.
4. **Sidebar.** A Docs section with the page tree (drag to nest or reorder), favourites and recent pages.
5. **Agents.** `app docs.list`, `docs.get` (Markdown), `docs.create`, `docs.update` (Markdown in, converted to
   blocks), scoped to the project. Page text is data, never instructions.
6. **Export.** A page or a tree exports as Markdown files, and the portable export (Phase 5) includes docs.

Live co-editing between people (Yjs) is not in this package. It comes with WP-80. Keep the store simple enough to
add it later. Notion import is a later package.

Vendor Orbit's editor package and its Markdown conversion with credit, restyled to Hivra's theme. Translate its
version and mention rules to rusqlite.

## Done when

- [ ] Tests: notes migrate with nothing lost; Markdown to blocks and back for every block type; versions on idle and
      on agent edit; restore makes a new version; mentions resolve; tree moves refuse cycles.
- [ ] Browser spec: create a nested page, type with the slash menu, mention a task, restore an older version.
      Screenshots in the PR.
- [ ] `npm run check` passes.

## Addendum (10 Nov 2026): an agent's edit to a page can wait for the person

Source: Nimbalyst (MIT, Copyright (c) 2024-2026 Nimbalyst Inc.). Ideas only, no code copied. Option, off by default.

`docs.update` can land as a proposal: changed blocks show in red (removed) and green (added) in the editor, and the person accepts or rejects each block. Until a block is accepted, readers and search see the page as it was. Accepting writes a version marked as the person's; rejecting writes nothing. `docs.get` tells the agent that a proposal is pending, so it does not write over it.

Tests: a rejected block leaves the page unchanged, an accepted block makes a version, and a second proposal on the same block replaces the first. Done when the setting is off by default and the Docs browser spec covers accept, reject and the default direct write.
