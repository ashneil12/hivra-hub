# WP-06: Retire Today, Being built and Needs you

The hub no longer has those screens. A project opens on its coding team. A stored Today, Being built, Decisions or Builds item is not a surface: the app opens that project's coding team. Settings → Decisions → Open opens the real Inbox. A project with no code folder shows a no-code page. A Lead open still in flight loses to the next real click.

Commits, not pushed: `00db8e4a` (the screens and the start), `65b3ca3b` (the browser specs), then the review fixes on this branch.

## What changed

- Today, Being built, Builds & playtests and the project's Decisions page are gone, with the sheets and the unit tests that only existed for them. Rooms, connectors, changes, Pages, new project, restore, onboarding, autopilot and proposals stay. Settings → Decisions stays.
- `showProjectToday` opens the coding team. With no project, the empty state stays. The first project, once there is one, opens on its coding team.
- Settings → Decisions → Open (`item: "inbox"`) opens the Inbox. It does not open the coding-team Lead.
- A project with no code folder shows "This project has no code folder yet." It does not keep the previous project's workspace. A blank or whitespace folder is not a code folder. A folder that has not loaded yet is left alone.
- A Lead open still in flight does not swallow the next real click. Uncovering the project (a focus that is not a click) is not a leave. A click is, and it cancels a hung open.
- `projectTodaySections` is gone. Nothing in the UI called it, and it still appended Being built.
- The browser stand-in returns seeded crew, decision, delivery and pull-request lists. A missing or bad value is an empty list.

## Where the old screens' contents went

| What the old screen showed | After WP-15 | Where |
| --- | --- | --- |
| Today: Waiting on you (questions, Take the pick) | lives in Inbox + the chat | Inbox `decision` items; the coding-team chat. The Today list is dropped. |
| Today: Needs you (gates, failures, red rows) | lives in Inbox + Crew | Inbox failure / credential / decision; Crew status word. Red/grey chip dropped. |
| Today: Since / what-changed paragraph | dropped | Robotic digest. Git changes stay in the Changes panel. |
| Today: Setup rows | dropped from Today | Connectors stay in Settings. |
| Today: Being built worker lines (where, chip, reason) | lives on Crew | Crew row: title, cli, model, status, how long, branch, diff, PR, checks. |
| Today: Latest build | dropped | Builds & playtests dashboard removed. Not the Changes tab. |
| Today: Latest dashboard / page | lives as Pages | `ProjectPagesView`, sidebar section `project-pages`. |
| Today: Later / older questions / ask search | dropped | Things that need the person are Inbox items. |
| Today: Ship notice | kept off Today | `ShipNotice` still on the empty home. Ship engine unchanged. |
| Today: Retrying / With Lead / Can't answer / Stalled chips and stuck rings | dropped | Not a sixth status word. Crew uses only the five words. |
| Being built: Can't answer, Needs you, Waiting on you sections | lives on Crew + Inbox | Same as above. |
| Being built: worker time, reason, PR line, parts, take a look, stop watching, open coding team | lives on Crew | Row actions open, message, stop, retry, land, open PR. Open goes to the chat. |
| Being built: finished toggle | lives on Crew | status `done`. |
| Needs you: project Decisions page in the main area | lives in Inbox | Inbox decisions, answer in place. |
| Needs you: QuestionSheet, OptionsSheet, OlderQuestions | dropped as sheets | Answer on the Inbox item or in the chat. |
| Settings → Decisions (`DecisionsPage`) | kept | Same component, settings only. Open goes to the Inbox. |
| Rooms, connectors, changes, Pages, new project, restore, onboarding, autopilot, proposals | kept | Out of scope. |
| Rail / mono stuck cards / room StatusMark | kept | Shared helpers. Coding-team nav chip removed. Stall lines say the rail. |

## Done when

- Nothing marked "lives elsewhere" is missing from Crew or Inbox. `tests/browser/wp06-home.spec.ts` opens the real app shell (not the wp15-crew fixture page) and checks the five status words, a worker line, pull request #12, "1 check still going", and an inbox decision, failure (no secret, no stack), credential and review. Chromium: both tests passed (2.1s and 2.6s) inside the full run below.
- The rail mark, the work split "1 working · 1 waiting · 1 needs you", and the Lead chat's stuck cards are in `tests/browser/wp06-rail.spec.ts`. Being built and Today are not asserted. Chromium: passed (3.1s) in the full run. The strip badge in `tests/browser/chatflow.spec.ts` does not depend on Today. Chromium: passed (6.4s). `src/features/hub/HANDOFF.md` no longer names `stuck-workers.spec.ts`.
- The screens' own browser specs are gone: `pm-22-stuck-ring`, `pm-23-stuck-ring`, `pm-30-today`, `pm-30h-lead-done-red`, `stuck-workers.spec.ts`, `r30-today`.
- `npm run check` passed (numbers under Commands). A seeded dev copy was not opened.

## Commands

`npm run check` (`check:web` then `check:scripts` then `check:rust`), after the review fixes:

```
Test Files  1080 passed | 2 skipped (1082)
Tests  8865 passed | 13 skipped (8878)
Duration  68.15s
# fail 0
test result: ok. 1346 passed; 0 failed; 2 ignored; finished in 39.92s
test result: ok. 32 passed; 0 failed; 0 ignored; finished in 0.18s
```

`tsc --noEmit`, `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` are inside that run and did not fail.

`npm run test:browser -- --project=chromium --reporter=list` (the full Chromium job, before the two locator fixes below):

```
8 failed
2 skipped
129 passed (12.9m)
```

Our specs in that run passed: `wp06-home` (both), `wp06-rail`, `chatflow` (both).

Then the two specs whose locators were wrong for the Lead chat:

`npm run test:browser -- --project=chromium --reporter=list tests/browser/b8-conversations.spec.ts tests/browser/pm-19-width-team.spec.ts`

```
6 passed (49.8s)
```

Nothing was pushed.

## Browser failures that are not this change

These four failed in the full Chromium run. The spec and the code they assert are the same as `origin/main` (`git diff origin/main` is empty for each). They were not "fixed" by restoring Today or by putting the word "stuck" back.

- `tests/browser/agents-page.spec.ts` expects an attention row `w:d3` whose status says "Stuck". The Agents page's attention list is only asking or needs-you (`readyPages.ts`). A quiet stall is "With its lead", not that list (`pageData.ts`). Both files match main.
- `tests/browser/mono-teams.spec.ts` expects "2 working · 1 stuck". The rail line is "N working · N waiting · N needs you" (`MonoRailSection.tsx` `railSplit`). A quiet stall is the Lead's, so it is not on that line. The file matches main. The received text was "2 working".
- `tests/browser/pm-20-agent-notes.spec.ts` opens `agent-notes.html?view=today` and looks for `[data-stuck-open]`. That attribute is not in the UI. `MonoRailSection.stuck.test.ts` expects it to be null. The fixture and the card match main. The other two tests in that file passed. Today was not put back.
- `tests/browser/workspace-performance.spec.ts` collects `Unavailable fixture service: home_dir`. The fixture and `App.tsx`'s `homeDir()` call match main. The resize checks in that test had already passed. The fixture does not allow `home_dir`.

Two failures in that same run were this branch, and the specs now pass:

- `b8-conversations.spec.ts` after reload used `__devHubSelect`, which only sets the selection, so the Lead stayed on top of Leadership team. A click on Leadership team is a leave (`closeChromeViews` → `closeMonoView`). The spec does that click.
- `pm-19-width-team.spec.ts` measured `[data-session-drop].first()`, the hidden empty workspace pane behind the Lead. It now measures the visible Lead chat.

## Not checked

- The tag. `git tag archive/hub-screens 32d0347b3e9baacd6e660bd2c0819fcd09723cc8` was not approved, so the tag is not on this machine. Do not push it.
- WebKit. It is not installed. Chromium only.
- A seeded dev copy of the daily app. Not opened. Dev-slot proof would need `npm run hub:dev`, which was not run.
- Windows clippy. `rustup target list --installed` was not approved, so `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings` was not run.
- The full Chromium job was not run again after the b8 and pm-19 locator edits. Those two files were run on their own and passed (6 tests).
