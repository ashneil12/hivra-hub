# WP-166: Upstream repo watch as a Mono habit

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| First Mate smoothness (Ash 10 Nov 00:14 UK) | S | WP-78 activity (on main), habits (on main); pairs with WP-165 | yes |

## Goal

A weekly (or daily) Mono habit runs the existing **repo watch** idea inside Hivra: compare pinned upstream SHAs the project tracks, write a short changes summary the person can read, and optionally enqueue draft upgrade packages onto WP-159 when the person has allowed that. The watch scripts stay local; nothing is published.

## Why

Ash (9 Nov): track every repo Hivra has used and watch updates. The Mac already has `hivra-research/repo-watch` and `source-watchlist`. Those are outside the hub. Closing the north-star gap means the First Mate can run the watch as a habit and surface results on Home / morning rundown.

## Read first

- Patterns in the local research `repo-watch/watch.py` and `source-watchlist/` (read-only inspiration; do not vendor private paths into the public repo).
- Mono habits, WP-78 activity log, WP-159 programme queue.
- Licence rules: only MIT / Apache-2.0 / MPL-2.0 for code takes; ideas-only otherwise (already in SOURCES.md policy).

## Build

1. Docs to `docs/hivra/work/WP-166-upstream-repo-watch-habit.md`.
2. In-repo, project-local pin list (JSON in project data or `.hivra/repo-pins.json` if the person opts in): url, licence, pin sha, notes. Seed empty; import helper may copy from a file the person picks. Tests.
3. Habit runner: fetch public compare refs with existing `gh` or git (timeouts); write `changes` summary into project docs or activity; never print tokens. Tests with fixtures (no live network in unit tests).
4. Optional: with WP-165 enabled, turn clear wins into draft programme rows (person setting, off by default).
5. Out of scope: launchd install, committing pins to public main without the person, AGPL vendoring, Hermes env files.

## Done when

- [ ] Habit produces a readable changes summary from fixtures.
- [ ] Off-by-default enqueue to programme queue.
- [ ] No tokens, no private home paths in committed text.

## Licence

Inspired by the local repo-watch mirror Ash already runs. Upstream projects keep their own licences in SOURCES.md when a take is proposed.
