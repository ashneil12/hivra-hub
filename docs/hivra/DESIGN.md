# Dropwave design rules

How the app's screens are laid out, what things are called, and how to change them without breaking the look. Any
agent that touches the frontend reads this first: an outside coding agent, or one of the app's own first mates working
on this repo. The matching skills are in `.agents/skills/dropwave-ui/` (change the app's own screens) and
`.agents/skills/make-a-hub/` (build a page inside the app, no app code changed).

These rules came out of six review rounds with Ash on 11 Nov 2026 (PR #252). Where a rule quotes him, that is the
reason for it. Check them against the code before leaning on a file name: files move.

## 1. The shape of the product

- **The owner** (the person) owns the work and sees about 1% of the decisions.
- **The Chief of Staff** is the first mate that reads every project. It is who the owner asks for anything, and it
  makes most of the calls. There is one, and it has **one chat** for everything (Ash, 13 Nov: "literally just one main
  chat ... full port one chat for everything"): no side chats, no "New chat", no chat of its own per project
  (`src/features/asks/model/oneChat.ts`). The owner should never need to go below it.
- **First mates** each run one line of work (a project's Lead runs its code; Design review reviews screens). A first
  mate has its own crew of workers and can have several chats.
- **Teams** are optional group chats of first mates inside a project. Council is a mode of a team's chat, not a place.
- **Hubs** are small screens a first mate builds for the owner (the code still calls them pages). They are how the app is
  extended without changing its code.

## 2. Words

| Say | Never say | Why |
|---|---|---|
| first mate | Mono, agent, bot (in anything a person reads) | The code still says `Mono`; the screen does not. |
| Chief of Staff | Coordinator, captain | "Captain" is the role tag in a list, not its name. |
| Needs you (in red) | Stuck, Blocked, Attention | "No Stuck word." One list, one colour (`NEEDS_YOU_RED`, `src/features/hub/ui/StatusMark.tsx`). |
| Inbox (sidebar row, with the red Needs you count) | Needs you as a place name in the full rail | The compact rail keeps "Needs you". |
| Teams, team chat | Rooms, groups | |
| Hubs | Pages, dashboards, panels | Ash's word (11 Nov). The code keeps `pages` in its names; a person never reads that word for them. A note's page in Notes is still a page. "The hub" never means the app itself: say "the app". |
| Home | Today, Overview | |
| Working, Stopped, Done | Running, Failed, Completed | Plain words, the same three everywhere. |

Write to the person in full sentences. No arrows, no code names (`WP-12`, file names, ids) in anything they read.
Example text in a mockup or a test starts with "Example:" and never contains a real chat.

## 3. The layout, left to right

1. **Project strip** (`src/features/hub/ui/ProjectStrip.tsx`): a Home tile on top, one tile per project with its red
   count, then +. Home is selected whenever Home or Home's Chief of Staff chat is open (`homeInView`,
   `src/features/hub/model/homeScope.ts`).
2. **Sidebar** (`src/app/shell/ProjectRail.tsx`), always in this order:
   Search; **Chief of Staff** (pinned first, on Home and in every project; `HubTopNav.tsx`); **Home**; Inbox; Notes;
   Automations; Hubs; pinned hubs;
   **First mates** (`MonoRailSection.tsx`, inside a project only: "no first mates on Home"; its + is "New first
   mate": a name and what it looks after, or one already made added to this project. A project starts with the Chief
   of Staff and its lead; every other first mate is the person's choice); **Teams**
   (`HubProjectItems.tsx`, inside a project only); Settings at the bottom.
3. **Main area**: whatever the sidebar row opens. Only the open thing is highlighted, in one place.
4. **Right panel**: a chat's sessions, notes, history and changes. Code tools (Git, files, changes, worktrees) stay
   hidden until Settings turns "Show code tools" on.

Home is a place of its own. From Home, nothing from the last project shows: not its teams, not its first mates, not its
name. Opening the Chief of Staff keeps Home selected, from Home and from inside a project: its one chat belongs to no
project.

## 4. Rules that hold on every screen

1. **Reuse before you build.** "Reuse the existing app UI and components; just enough changes." A new screen copies an
   existing one. Look in `src/shared/ui/` first: `Popover`, `Modal`, `ConfirmDelete`, `SecondaryButton`,
   `SearchableSelect`, `PaneHeader`, `icons`. A sidebar row is a `RailAction` (`src/app/shell/RailAction.tsx`).
2. **One chat look.** Every one-to-one chat (Chief of Staff, a Lead, any first mate, a plain chat) is the same layout:
   the chat list on the left, the same composer, tab strip and footer (`ONE_CHAT_LOOK`,
   `src/features/hub/model/hubBundle.ts`). Never give one kind of chat its own header or message box.
   **The list is the open first mate's own**: its main chat on top (marked "Main chat"), then its other chats and the
   chats it started. A two-way switch above the list (the first mate's name, Everyone) brings in the rest of the
   project's chats; the choice is kept (`src/features/hub/model/chatListScope.ts`). A chat never shows under a first
   mate it does not belong to.
   **The Chief of Staff's one chat is the exception to the list**: it has no chat list and no "New chat". Whatever box
   a message to it is typed in (Home's, a project home's), it lands in that one chat. Beside its composer sits
   "Catch me up", always there: one app card of what finished, what was decided for him and what needs him since the
   last one (`src/features/asks/model/catchUp.ts`), read from the app's records, never written by a model. Chats it
   had before one chat are kept and stay reachable ("Earlier chats"), but nothing starts another.
3. **Always say who you are talking to.** A chat's header, its row in the list and its empty state carry the first
   mate's name and mascot, never a model name or the word "Chat" alone.
4. **The gallery look for list screens** (Hubs, Automations, Settings lists): full width with `px-6 pt-5 pb-10
   xl:px-8`; a 20px semibold title; one grey line under it; pill filters (`h-7 rounded-full px-3 text-[12px]`, the
   selected one `bg-content text-background-base`); then cards (`rounded-lg border border-stroke`). No centred narrow
   column for a list.
5. **Anything that pops up is a `Popover`** (`src/shared/ui/Popover.tsx`): it closes on a click outside and on Escape
   (`onDismiss`), and it places itself (`src/shared/lib/popover.ts`). Menus use the class
   `solid-panel-glass p-1 font-sans`. Never hand-roll a fixed-position panel: that is how the Compare panel ended up
   only closing from its own button.
6. **Pick-several lists show a tick box on every row**, ticked or not, with `role="checkbox"` and `aria-checked`.
   Pick-one lists show a round mark.
7. **Settings live in Settings.** A chat's side panel shows who is in it and its conversations. How a team behaves
   (who answers, who leads) is under Settings, Teams, on that team's row. The defaults must be right without anyone
   opening it.
8. **Open on the thing in view.** A list that can be filtered by project opens on the project the person is in
   (`pagesScope` in `PagesView.tsx`), and on everything from Home.
9. **Theme tokens only.** Colours, surfaces, borders and shadows come from the tokens (`text-content`,
   `bg-surface`, `bg-surface-raised`, `border-stroke`, `bg-selection`, `bg-theme-accent`). No hex, no `rgb()`, no
   Tailwind colour names, except the one Needs you red and real status colours. Small text is never fainter than
   `text-content/60` (hints may go to `/55` on raised surfaces; check contrast in Glass, Graphite and Dusk).
10. **Sizes.** Body and rows 13px; hints and labels 12px (`text-xs` for section labels); tags 11px. Rows are `h-7`
    in the sidebar, `h-8` in menus. Icons `size-3.5` with `strokeWidth={1.75}`.
11. **One primary button per surface.** `bg-content text-background-base` (or `bg-accent text-black` on Home). The
    rest are quiet (`border border-content/20` or text only).
12. **Empty is a sentence.** A section with nothing says so in one grey line ("Nothing running right now."). No empty
    cards, no example rows in the real app.
13. **Every control keeps a test hook.** A `data-…` attribute on anything a test or a first mate would click, and an
    `aria-label` on every icon-only button. When a control moves, its hook moves with it.
14. **A row that needs you opens its own card, where it is.** In the Inbox a Needs you row opens beside the list
    (`src/features/needs/ui/NeedDetail.tsx`), laid out like the Inbox's pull request card: the kind, project, who and
    when on one quiet line, the ask as the title, a hairline, then **every answer it offers** (`NeedChoices.tsx`: one
    bordered row each, lettered a, b, c so a key press picks one, the asker's pick marked Suggested), the way to the
    chat or page it came from, and a box shaped like the Inbox's comment box whose words answer the question itself
    when the row can (`item.answer`), else go to that chat. A row reads like the Inbox's own rows (kind · project and
    the time, the ask in bold, who asked · "2 answers · Suggested: …", an arrow), so it is plainly something to open.
    In the Chief of Staff's lists and a catch-up the card slides open under its row (`Reveal.tsx`) and an answer is
    seen to land: the chosen row lights with a tick, then "Answered: Take A. EXO lead has it." takes the card's place
    (`needs/model/answeredNeeds.ts`). Home keeps its one tap. A row never throws the person onto another screen without saying where. Open chat opens the chat that
    asked, on the message that asked, with its words lit (`openNeed` in `needContext.ts`, the jump in
    `src/features/sessions/model/transcriptJump.ts`), never just the chat's latest message. The Inbox's tabs read All,
    Asks, then each source: asks and work items stay apart (`src/features/needs/model/inboxShow.ts`).
    An ask of the person's that two daily checks found with nothing moved is one such row too ("You asked: <the ask's
    words>", "Still open since Tuesday. Mia hasn't moved it."), once per quiet spell. Its card's three answers do
    different things and say so: **Answer it** opens the chat that asked, on the message, and leaves the card as it
    is; **Let it go** is the person's own drop; **Remind Mia** sends the first mate one app message and the row goes
    until it has been quiet through two more checks (`asks/model/askQuiet.ts`, `needs/model/quietAsks.ts`).
    A first mate's chat opened from the Chief of Staff's one chat (Working's "Message EXO lead", a job's Open, a
    catch-up's Open) opens **beside** it, in the panel next to the chat, never in its place (`asks/model/besideChat.ts`).
    What the person sends there leaves one quiet line in the one chat ("You messaged EXO lead: … · the Chief of Staff
    knows.", `asks/ui/BesideMessageLine.tsx`): the app's line, with no agent name over it and no turn row under it.
    A question is answered **inside the one chat** (`asks/ui/InlineNeed.tsx`): a reply links a Needs you item on a line
    of its own (`hivra://local/need/<key>`, `asks/model/needLinks.ts`) and the chat draws it as that item's own card
    (the same `NeedDetail` the Inbox opens: every answer lettered, the pick marked, a box for his words, Open chat
    beside). The app's Needs you roll-up shows its items the same way, numbered, under a quiet "Needs you now". Once an
    item stops waiting the card folds to one line ("Answered: … EXO lead has it." or "No longer needs you: …"). The
    chat store keeps these cards, the catch-up card and the "You messaged" line through a relaunch
    (`asks/model/keptCards.ts`).
15. **A flow asks one thing a step.** First run (`HubOnboarding.tsx`) goes welcome, the first project, its first
    mates, the coding tools, a look, done; each step has one heading and one choice, nothing is required, and the
    last step says back what was chosen before anything opens. A list a person chooses from says what each choice
    does in full under its name, never cut short.
16. **Taste: a task screen, not a landing page.** Group with space, not boxes: no card inside a card, no grid of
    same-size cards as the page, no big numbers over a list, no coloured side borders. One glyph per state, the same
    everywhere. Secondary row buttons show on hover and focus. The `hub-taste` skill has the list; the design skills it
    names (`.agents/skills/CREDITS.md`) have the depth.

## 5. Where things are

| Screen | File |
|---|---|
| Home (cards, Chief of Staff box) | `src/features/home/ui/HomeScreen.tsx` (drawing), `HomeView.tsx` (wiring) |
| Needs you (the one list) | `src/features/needs/model/needsLive.ts`, `needsYou.ts`; in the Inbox: `src/features/needs/ui/InboxNeeds.tsx` (rows), `NeedDetail.tsx` (a row's card) |
| Sidebar | `src/app/shell/ProjectRail.tsx`, `Sidebar.tsx` (chat list), `MonoRailSection.tsx`, `src/features/hub/ui/HubTopNav.tsx`, `HubProjectItems.tsx` |
| What is selected | `src/features/hub/model/hubNav.ts` (`HubSelection`), `homeScope.ts` |
| A first mate and its chats | `src/features/monos/model/mono.ts`, `monoWorkspace.ts` |
| Team chat, council switch | `src/features/hub/ui/GroupChatView.tsx`, `RoomResponder.tsx`, `src/features/council/ui/` |
| Hubs | `src/features/pages/ui/PagesView.tsx`, `src/features/pages/model/pages.ts` |
| Settings | `src/features/settings/ui/SettingsView.tsx`, `src/app/shell/SettingsRail.tsx`, `src/features/hub/ui/TeamsPage.tsx` |
| First run | `src/features/hub/ui/HubOnboarding.tsx`, `HubOnboardingSetup.tsx`, `HubOnboardingGate.tsx` |
| Composer extras (Compare) | `src/features/sessions/ui/FanOutPicker.tsx` |
| What each screen calls | `docs/hivra/work/dropwave-wiring.md` |

## 6. How to check a change

1. Unit tests beside the code: `npx vitest run <folder>` while working, then `npm run check:web` once.
2. Look at it. `npm run mockup:build` writes the real frontend with example data to `target/mockup/`
   ([ux/MOCKUP.md](ux/MOCKUP.md)); serve that folder and open `mockup.html?reset`. The example data is in
   `src/dev/mockup/data.ts`; bump `SEED_VERSION` in `seed.ts` when it changes. Or run a dev copy: `npm run hub:dev`.
3. Take a before and an after screenshot of every screen you touched, at 1440 by 900, and put both in the pull request.
   "Visually nothing makes sense" was the cost of skipping this.
4. Walk the paths around your change: open it from Home and from a project, switch projects, come back. Most of the
   round 6 bugs were a screen that was right on its own and wrong after a click somewhere else.
5. Anything a person sees gets a browser spec in `tests/browser/`.

## 7. Changing the app from inside the app

The direction (Ash, 11 Nov): "the entire harness should be editable by the agent itself" and "moddable, so modders can
create mods for this harness". Three levels, smallest first:

1. **A page** (a "hub"): a first mate builds it from a sentence, the owner sees a preview and keeps it. No app code
   changes, it runs in a sandbox with only the reads and taps it lists. Skill: `make-a-hub`. This is the default
   answer to "can it show me X".
2. **A plugin**: skills, first mates, panels and commands in one folder (`src-tauri/plugins/`, the bundled
   `hivra-creator` plugin writes them; `docs/hivra/plugins/README.md`). This is what a mod is today.
3. **The app's own screens**: a first mate works in this repo on a branch, follows this file and the `dropwave-ui`
   skill, proves the change in a dev copy, and it reaches the owner's app only through `npm run hub:ship` from merged
   main (AGENTS.md). Never by editing the installed app.

Ideas waiting to become pages or plugins rather than core screens: block documents (the Orbit-style docs in
`src/features/docs/`), team message boards, task boards.
