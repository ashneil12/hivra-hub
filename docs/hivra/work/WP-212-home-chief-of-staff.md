# WP-212: Home with the real Chief of Staff

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | L | WP-210 (reads `useNeedsYou`; stub it behind the same hook until 210 lands) | yes |

## Goal

Home is the place for everything across projects. At the top is the real Chief of Staff's chat: ask anything, or hand
work to any project, and its answer appears right there. Under it are three short sections: **Needs you** (the top
five, with their buttons), **Working now** (one line per project with running workers) and **Done today**. Nothing
else. It matches [ux/mockups/Main.png](../ux/mockups/Main.png).

## Why

Ash, 11 Nov: "home doesnt even work". Home's box is not a chat. `askChief` (`chief/model/answer.ts`, called from
`home/ui/HomeView.tsx` through `home/model/ask.ts`) guesses the kind of question with a regex. Anything else that names
exactly one project is filed as a task through `fileIntoProject`, the box says "Filed.", and nothing starts. So "how is
EXO going?" becomes a task in EXO. Home also lists the projects the rail already shows, says "All quiet." under a red
Needs you, and has loose "Move up", "Hide" and "Pin a panel" text.

## Read first

- [UX.md](../UX.md), [ux/mockups/Main.png](../ux/mockups/Main.png).
- WP-88 ([WP-88-chief-of-staff.md](WP-88-chief-of-staff.md)): the cross-project read scope is built
  (`chief/model/scope.ts`, `tools.ts`, `reads.ts`). What is missing is the chat itself.
- `home/ui/HomeScreen.tsx` (`HomeChatBox`, the sections, the "All quiet." line, Pin a panel), `home/ui/HomeView.tsx`,
  `home/model/*` (`arrangement.ts` keeps the order and pins; keep it).
- `hub/model/hubData.ts` (the Monos list, with the default team first and Chief of Staff in the top slot by id) and
  `hub/model/hubChats.ts` ("who answers first").
- How a Mono's chat session is opened and sent a turn today (the Mono chat in the sidebar), so Home reuses it.

## Build

1. **The Chief of Staff's chat on Home.** The box at the top sends Ash's words as a real turn to the Chief of Staff
   Mono's own chat session, the same session its sidebar entry opens. Pick the Mono the way `hubData` picks the
   top slot (by id, so a renamed Chief of Staff still counts). Home shows the latest exchange inline: Ash's last
   message, then the reply as it streams, with the reply's buttons when it asks something. It also shows "Open full
   chat", which opens that session. The placeholder reads "Ask anything, or hand work to any project". A line under the
   Mono's name says what it can read ("read all 7 projects") only when WP-88's scope is on for it.
2. **No guessing.** Remove `askChief`, `fileIntoProject` and the regex routing from Home's path. Handing work to a
   project is the Chief of Staff's own job: it files tasks through its WP-88 tools, and that project's coding team
   picks them up. Home never files anything itself. Delete `home/model/ask.ts` and `chief/model/answer.ts` if nothing
   else reads them.
3. **No Chief of Staff yet.** When the roster has none, the box says so in one line with an "Add the Chief of Staff"
   button. The button adds the starter template (WP-05) with WP-88's scope on, then opens the chat. It never silently
   falls back to filing tasks.
4. **Needs you.** The first five items of `useNeedsYou()`, oldest first. Each row has the project as a small tag, the
   item's sentence and its actions as buttons, and the row opens where the item came from. The header shows the count
   and "See all", which opens the Needs you screen (WP-211; until then, the Inbox). The section is hidden when the
   list is empty.
5. **Working now.** One line per project with running workers: "4 workers: chat move fixes, PR watch, commit
   guard, crew locks", with "since 03:40" on the right. It comes from the app's own open delegations (the same
   `workingCount` as WP-210). It is hidden when nothing is running.
6. **Done today.** Up to five lines of what finished today: merged pull requests, finished tasks and accepted
   delegations. They come from the activity log (WP-78) and the work log, newest first, each with its time, each
   opening its source. "See all" opens the Work log. It is hidden when empty.
7. **The header.** "Home", today's date, and one **Customize** button on the right. Customize holds what the loose
   text did: move a section up or down, hide it, pin a Page as a section (`arrangement.ts`, kept as is).
8. **Gone from Home:**
   - the projects list (the rail is that list);
   - the usage line (it lives in the status bar, WP-214);
   - any Ash OS note;
   - "Pin a panel" and the loose move and hide text;
   - "All quiet.".
   With nothing at all to show, Home is the Chief of Staff's chat and one grey line: "Nothing needs you."
9. **Opening the app** keeps WP-73's rule: Home when the list has anything in it, otherwise where Ash was.

## Done when

- [ ] Tests with the fake Claude (`scripts/fake-claude.mjs`, `claudeFakeCli`):
  - typing "how is EXO going?" on Home sends one turn to the Chief of Staff's session, and creates **no** task in any
    project;
  - the reply streams into Home's box;
  - "Open full chat" opens that same session;
  - with no Chief of Staff in the roster, the box offers to add it and files nothing.
- [ ] Tests: each of the three sections hides when empty; Needs you shows at most five and its count matches
  `needsCount()`; "All quiet." no longer exists anywhere in `src/features/home`.
- [ ] Browser spec `tests/browser/wp212-home.spec.ts` with example data matching `Main.png`. It covers a turn on Home,
  every section, Customize (move, hide and pin, all kept after a reload) and the empty state. It saves a 1440 × 900
  screenshot of each state.
- [ ] Before and after screenshots of Home in the PR (example data), and the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-212/`, never pushed).
- [ ] `npm run check` passes.
