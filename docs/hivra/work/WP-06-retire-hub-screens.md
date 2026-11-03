# WP-06: Retire Today, Being built and Needs you

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | M | 15 | no |

## Goal

The Hub's own status screens and their chip rules are gone. The Crew tab and the Inbox (WP-15) are where a person
sees work and what needs them.

## Why

They duplicate what the Crew tab and Inbox now show, depend on rules tuned round by round (red only for Needs you,
grey With <Lead>, stuck rings) and made the app feel robotic. SPEC.md sections 10 and 11.

## Read first

- `src/features/hub/ui/` (`HubSurface.tsx` and its tests, `BeingBuiltView.tsx`, `BuildsView.tsx`,
  `DecisionsPage.tsx`, `OlderQuestions.tsx`, `QuestionSheet.tsx`, `ProjectDecisions*`, `ProjectStrip.tsx`).
- `src/features/monos/model/workerStuck.ts`, `briefedTeams.ts`, the status-line and chip helpers they use.
- The `tests/browser/pm-*.spec.ts` specs WP-01 marked "goes with WP-06".

## Build

1. Inventory what each screen shows. For each item, name where it lives after WP-15 (Crew tab, Inbox, a project's
   chat) or say it is dropped. Put the table in the PR.
2. Remove the screens, their chip and status-line rules, and their unit and browser tests together.
3. Point the app's entry (IS_HUB_BUNDLE start) at the project's coding team chat instead of Today.
4. Tag the last commit with them as `archive/hub-screens`.

## Don't

- Don't remove rooms (`GroupChatView.tsx`), connectors, changes, Pages, new project, restore or onboarding.

## Done when

- [ ] Nothing the inventory marked "lives elsewhere" is missing from the Crew tab or Inbox (browser spec).
- [ ] The browser job is green (the last "goes with WP-06" specs are gone with their screens).
- [ ] `npm run check` passes; a seeded dev copy opens on a project's coding team chat.
