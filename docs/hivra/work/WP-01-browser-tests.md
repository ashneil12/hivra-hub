# WP-01: Browser tests green

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| A | M | none | yes |

## Goal

The `browser` CI job (Playwright, Chromium and WebKit) passes, or fails only on tests that WP-06 deletes along with
the screens they cover.

## Why

It has been red on `main` since the fork first ran CI (run 41674008302): 45 tests, 88 failures over both engines.
A red job hides real regressions from every other package.

## Read first

- `playwright.config.ts`, `tests/browser/fakeTauri.ts`, `tests/browser/workspace-performance.tsx` (the fixture
  page most upstream specs load).
- `src/features/hub/ui/HubOnboardingGate.tsx` (`onboardingGate`), `src/features/hub/model/onboarding.ts`
  (`monocode:hub-onboarded`), `src/features/hub/model/setupProof.ts` (`monocode:hub-setup-not-now`).
- The failing list: the `browser` job log of the latest CI run on `main` (`gh run list --branch main`).

## What fails today

- **9 upstream specs can't click**: the Hub's first-launch onboarding card covers the fixture page.
  `app-view-tabs.spec.ts` (4), `layout-opt-in.spec.ts:13, :50, :181`, `right-panel-graph.spec.ts`,
  `theme-transparency.spec.ts`.
- **6 upstream specs meet Hub changes**: the chat pane stays hidden (`layout-opt-in.spec.ts:90, :159`,
  `workspace-performance.spec.ts:191`), the busy chip text changed from `Mac busy: …` to
  `Your Mac is busy (CPU, memory)…` (`resource-pressure.spec.ts`), and the transcript jumps 26 px when a Mono
  completion attaches (`transcript-scroll.spec.ts:26`, two cases).
- **30 Hub specs** no longer match the Hub's UI: `agents-page`, `b8-conversations`, `coding-team`,
  `mono-chat-stop`, `mono-teams`, `stuck-workers`, `workflow-run` and the `pm-*` specs.

## Build

1. In the browser fixtures only, start with onboarding finished and the setup card snoozed (set both keys before
   the app mounts, e.g. in `fakeTauri.ts` or an init script the fixtures share). Don't change the gate's behaviour
   in the app.
2. For each of the 6 upstream specs, find the Hub change that broke it (`git log -S`). If the Hub change was
   deliberate and still wanted, make the app satisfy upstream's spec another way, or explain in the PR why the spec
   must change. Prefer restoring upstream behaviour: upstream specs are not ours to edit.
3. Classify each of the 30 Hub specs in the PR description: **stays** (the feature survives SPEC.md section 11:
   fix the spec or the bug) or **goes with WP-06** (Today, Being built, Needs you, status chips: leave it for WP-06
   to delete with its screen). Fix every **stays** spec.

## Don't

- Don't skip, quarantine, `test.fixme` or loosen any spec to get green.
- Don't change upstream spec files unless step 2's explanation says why.

## Done when

- [ ] The 9 onboarding-blocked specs and the 6 upstream specs pass on both engines.
- [ ] Every **stays** Hub spec passes; the PR lists the **goes with WP-06** ones.
- [ ] `npm run check` passes.
