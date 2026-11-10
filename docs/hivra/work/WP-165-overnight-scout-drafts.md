# WP-165: Overnight scout that drafts packages (off by default)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| First Mate smoothness (Ash 10 Nov 00:14 UK) | M | WP-159, WP-84 research-plan-build (on main), WP-164 helpful | yes |

## Goal

An optional overnight First Mate habit scouts public upstream notes and local research folders the person named, and writes draft package briefs into the programme queue as `parked` or `queued` drafts. It never launches builders, never merges, never spends, and stays off until the person turns it on.

The feature is off by default.

## Why

Tonight's overnight scout wrote WP-156 to 158 drafts for the morning. Ash wants that loop inside Hivra. WP-84 already researches before building; this package is the scheduled, quiet draft writer that feeds WP-159.

## Read first

- WP-84 research-plan-build, WP-159 queue, Mono habits.
- Local research layout ideas from the research notes (do not commit private paths; the setting stores a person-chosen folder bookmark through the existing folder picker).
- Curate, don't invent: only propose packages that map to MIT or Apache patterns already in `docs/hivra/SOURCES.md` or a clear product ask the person already approved.

## Build

1. Docs to `docs/hivra/work/WP-165-overnight-scout-drafts.md`. Mark feature off by default.
2. Habit + setting: schedule (default daily 23:00 local), max drafts per night (default 3), output as programme rows with status `queued` and a `draft` flag, or `parked` if the draft touches auth, network listeners, merge approval, or secrets.
3. Scout steps: read SOURCES.md + person-approved watch list summary (WP-166 when present); refuse to invent greenfield product ideas with no source; write brief text into the project's data folder (not into `origin/main` by itself). Tests with fixture sources.
4. Morning rundown (WP-164) lists new drafts. No notifications during quiet hours except the morning habit.
5. Out of scope: auto-launch, auto-merge, browsing the public internet beyond what existing hub tools already allow, publishing the app, phone pairing.

## Done when

- [ ] Default off; with it on, at most N drafts land on the programme queue and never auto-start.
- [ ] Auth / merge / secrets drafts are `parked` with security-park.
- [ ] No private absolute paths in committed code or docs.

## Licence

Product behaviour. Curates existing SOURCES. Ideas from the overnight chief-of-staff process; no new vendored tree.
