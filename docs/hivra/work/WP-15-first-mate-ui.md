# WP-15: First mate UI: the Crew tab and the Inbox

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | L | 03, 10, 11, 14 | no |

## Goal

A person sees their crew at a glance and finds everything that needs them in one place, with a calm, plain UI.

## Why

SPEC.md section 10. It replaces the Hub's Today, Being built and Needs-you screens (removed by WP-06) and their
chip rules. OpenMausBot's "a messaging app, not a dashboard" and OpenBot's quiet digest set the tone.

## Read first

- SPEC.md sections 4 and 10. WP-10's `derive_status`, WP-11's events, WP-14's decisions.
- The right panel: `RightPanelTab` in `src/features/settings/model/appearance.ts` (today `files`, `changes`,
  `graph`) and where `App.tsx` renders it.
- Upstream's Inbox: `src/features/inbox/` (`InboxKind`, `InboxItem`, the list and detail views).
- `src/features/monos/model/briefedTeams.ts` (the one-line-per-brief idea worth keeping).

## Build

1. **Crew tab** in the right panel, next to Files, Changes and History. One row per worker of the current
   project: title, CLI and model, status (from `derive_status` only), how long, branch, diff size, PR and checks.
   Row actions: open as a tab, message (WP-14 steering), stop, retry, and land or open the PR (WP-12).
2. **Inbox items**: a new `InboxKind` for first-mate items: decisions (answer in place with the options, the
   recommended one marked), results ready for review, failures, and credential needs. Each links to its chat and
   its worker. Answering a decision there releases its work (WP-14).
3. **The first mate's chat** shows plain messages plus one compact line per brief ("Fix the save bug: 2 working,
   1 needs you") that opens the Crew tab filtered to it.
4. **Quiet by default**: needs-you items notify at once; everything else is collected into at most one digest an
   hour.
5. Words: working, needs you, done, failed, paused. Nothing else.

## Don't

- Don't port the old chips, rings or red/grey rules. Don't add a dashboard screen.

## Done when

- [ ] Browser specs with screenshots: the Crew tab with workers in each status, a decision answered from the Inbox
      releasing its worker, a failure shown in plain words, the digest.
- [ ] `npm run check` passes; a dev-copy check on Ash's Mac with a seeded project.
