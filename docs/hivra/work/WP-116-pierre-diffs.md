# WP-116: Pierre's Diffs and Trees for the review screen

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M | M | none | yes |

## Goal

The person can switch a Hivra diff to a split (side-by-side) view, and the file tree next to a diff can use Pierre's path-first tree, without losing today's unified diff, hunk staging, or the existing inline comment that becomes a chat message. Pierre's packages are used as pinned npm dependencies, not vendored file copies, unless a pin is impossible.

## Why

A 4 Nov find: after the OpenAI deal, Pierre left [Diffs](https://github.com/pierrecomputer/pierre/tree/main/packages/diffs) and [Trees](https://github.com/pierrecomputer/pierre/tree/main/packages/trees) open under Apache-2.0. Verified 9 Nov 2026: repo `pierrecomputer/pierre` at commit `b6cf40c`, licence Apache-2.0, appendix line "Copyright 2025 Pierre Computer Company". Packages: `@pierre/diffs` 1.6.4 and `@pierre/trees` 1.0.0-beta.6. Trees also carries a NOTICE for ideas derived from `@headless-tree/core` (MIT, "Copyright (c) 2023 Lukas Bach"). About 6.5k stars, still pushed on 9 Nov.

Hivra's changes panel already has a strong unified diff, hunk staging, and a simple line comment that becomes a chat message. It has no side-by-side mode (`UnifiedDiffView.tsx`). An earlier T3 pass skipped review-thread extras on purpose because Ash does not review diffs line by line. This package does not add saved review threads or a GitHub-review workflow. It only adds a split view and, if it is a small hook, a better file tree. The unified view stays the default.

## Read first

- Pierre, local clone only as a read-only reference if needed, otherwise the published packages: `packages/diffs/README.md`, `packages/trees/README.md`, `packages/diffs/LICENSE.md`, `packages/trees/NOTICE.md`. Prefer `pnpm add` / the repo's package manager of a **pinned** version over copying `src/`.
- Hivra: `src/features/source-control/ui/{UnifiedDiffView,WorkingTreeDiff,CommitDiff,SessionChangesDiff,GitChangesPanel}.tsx`, `src/features/source-control/model/unifiedDiff*.ts`, `diffComment.ts`. Inventory note: unified view only, no side-by-side.
- Theme: Pierre adapts to Shiki themes. Use Hivra's existing theme tokens; do not import Pierre's product look wholesale.

## Build

1. **Pin, do not fork.** Add `@pierre/diffs` at a pinned version (start with 1.6.4 unless a later patch is clearly compatible) and, if you use it, `@pierre/trees` at a pinned version. Record both in credits.json, NOTICE (including the Trees NOTICE for Lukas Bach if Trees is used), SOURCES.md and the README inspirations list. Run `npx vitest run src/features/settings/model/credits.test.ts`.
2. **Split view, opt-in.** On a working-tree, commit, session or PR diff, a control switches between Unified (today, default) and Split. The choice can persist in local UI state. Staging hunks and today's inline comment must keep working in unified view. If hooking staging into the split view is more than a modest change, Split is view-only and the control says so; staging stays on Unified. Tests for the switch and for unified staging still working.
3. **Trees, only if cheap.** If the existing file list next to a diff can be replaced with `@pierre/trees` in a small wrapper (paths as keys, Hivra theme, no new selection model), do it. If it needs a redesign of the changes panel, skip Trees and say why in PR.md.
4. **Do not add** saved review threads, "viewed" marks, or a Pierre account/cloud path. Those stay out of scope.
5. Browser spec on Chromium and WebKit: open a diff, switch to Split, switch back, confirm unified hunk staging still works.

## Copy with credit

- Component: "Pierre Diffs" (`@pierre/diffs`), Apache-2.0, "Copyright 2025 Pierre Computer Company", where the package is declared and wrapped, how: "Pinned npm package for the optional split diff view (WP-116)."
- If Trees is used: "Pierre Trees" (`@pierre/trees`), Apache-2.0, "Copyright 2025 Pierre Computer Company", plus the NOTICE text for `@headless-tree/core`, MIT, "Copyright (c) 2023 Lukas Bach."
- Read the licence files at the pinned version and copy the exact copyright lines; do not guess.

## Done when

- [ ] Unified remains the default and staging still works there.
- [ ] Split view is available on at least the working-tree or session diff, with a browser spec on Chromium and WebKit.
- [ ] Packages are pinned; credits, NOTICE and SOURCES are updated; `credits.test.ts` is green.
- [ ] No review-thread product, no Pierre cloud, no em dashes or en dashes in text a person sees.
