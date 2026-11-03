# WP-20: Coding team as every project's first mate

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | M | 11, 12, 13, 15 | no |

## Goal

Every project has a coding team: a general first mate that is the project's home chat. It is all a person needs to
get coding work done; Monos are optional.

## Why

Ash: "Coding team is just the general user coding agent… you don't necessarily need to use the Monos."
SPEC.md section 5.

## Read first

- `src/features/monos/model/codingTeamContext.test.ts` and the coding team code it covers (`rg -l codingTeam src`),
  `leadFlow.ts`, `subChats.ts`, `briefedTeams.ts`, `src/features/hub/ui/NewProjectView.tsx`, onboarding
  (`HubOnboarding.tsx`, `HubOnboardingSetup.tsx`).
- WP-10 to WP-15.

## Build

1. Adding or opening a project creates its coding team if it has none: a first mate on the WP-10 contract, with
   crew rules from WP-13's defaults and the delivery default from WP-12.
2. The project opens on its coding team chat. Extra chats with the coding team are allowed, as today.
3. Today's coding team Lead chats become the coding team chat, history kept (a migration, tested on a seeded
   copy).
4. First launch: choose the CLIs you have, choose a project, land in its coding team chat. Monos and groups are
   offered, never required.

## Done when

- [ ] Tests: a new project gets one coding team; opening a project lands on it; a seeded Lead chat migrates with
      its history.
- [ ] A browser spec walks first launch to the first brief; `npm run check` passes.
- [ ] Dev-copy check on Ash's Mac with `--seed`: existing projects open on their coding team with history.
