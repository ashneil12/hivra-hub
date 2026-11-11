# WP-213: The rail and a project's home, captain first

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | L | WP-210 (counts), WP-212 (the Chief of Staff chat on Home: reuse it, don't build a second one) | yes |

## Goal

A project opens on the **Chief of Staff's chat for that project**, with an "At a glance" column beside it and one chip
per first mate above it. Tapping a chip opens that first mate's chat on the side, in place of the glance column. Home
takes the same two-column shape. The rail holds places only. It matches
[ux/mockups/Project.png](../ux/mockups/Project.png) and [ux/mockups/FirstMate.png](../ux/mockups/FirstMate.png), and
[UX.md](../UX.md) "The places".

## Why

Ash, 11 Nov 05:33: "The main interface is a chat. Whether for the homepage or for projects. Chief of staff is the
default agent ... each project should have its own home area as well with a chat and just relevant stuff at a glance.
Talking with first mates is possible as well on the side, but it should be simplified so that you don't need to see all
the chains of sub chats." In 0.16.15 a project had no home: the project row, "Coding team" and "Hivra lead" all opened
the Lead's workspace, sub-chats, model chips and git line counts filled the main screen, and the project list appeared
four times with different names. The earlier version of this brief made the coding team's chat the project's home; the
captain model replaces that.

## Read first

- [UX.md](../UX.md) "The chain of command" and "The places"; the two mockups above (open the `.html` files to inspect
  sizes and colours).
- WP-212's Home chat (`home/ui/HomeScreen.tsx`, the Chief of Staff pick in `hub/model/hubData.ts`) and how a Mono's chat
  session is opened and sent a turn (the Mono chat in the sidebar).
- `hub/ui/ProjectStrip.tsx` (the rail), `app/shell/Sidebar.tsx`, `app/shell/MonoRailSection.tsx`, the project rail
  sidebar (`HubProjectItems`), `hub/model/leadRoleName.ts`, project memberships (which Monos work on which project,
  `hub/model/localHub/`).
- The existing worker views (`monos/ui/StuckWorkerCard.tsx`, `SubChatList.tsx`, `DelegationNotices.tsx`) and the diff
  and file panels (they become the side panel's Crew, Changes and Files tabs).
- The Autopilot setting store (the switch stays in the header; the setting and its default don't change).
- Collisions: WP-210 and WP-212 are being built now. Merge `main` often and keep hooks small.

## Build

1. **The rail.** From the top: Home; one tile per project (initials, the name under it, the red `needsCount(project)`
   badge, a small blue dot while `workingCount(project)` > 0); **+** to add a project. At the bottom: **Agents**,
   **Decisions** (red badge = the whole Needs you count) and **Settings**. Remove the Autopilot and Hub tiles in the Hub
   bundle (`IS_HUB_BUNDLE`; upstream's rail is untouched). Project groups on the strip (WP-137,
   `hub/model/stripGroups.ts`) stay as they are. Until WP-211 and WP-219 land, Decisions opens the Inbox and Agents
   opens today's Agents page.
2. **The project's Chief of Staff session.** Opening a project shows the Chief of Staff Mono's chat **for that project**:
   one session per (Chief of Staff, project), made on first open in the project's folder, titled with the project's
   name, and reopened after that. It is the same Mono with the same memory as on Home; its first turn in a new session
   carries a short note naming the project it is scoped to. Ash's words go to it as real turns, exactly as WP-212's
   Home chat does. Placeholder: "Ask anything, or hand <Project> some work". Under the box, one grey line:
   "Chief of Staff on <engine>".
3. **The header.** One row: the project's name, the grey line "Chief of Staff, on this project", and on the right the
   **Autopilot** switch for this project (it reads and writes the same per-project setting the Autopilot page does
   today, shows the real state and changes no default; Autopilot stays off on the daily app until Ash turns it on).
4. **First mate chips.** A second row under the header: "First mates", then one chip per first mate of this project,
   each with its avatar, its department name and one status word ("4 working", "drafting", "idle", red "needs you").
   - The project's Lead (the coding team) is the **Coding** first mate. "Hivra lead", "Coding team" and the old project
     row all now lead here: the project's home with the Coding chip open.
   - Every other Mono that works on this project is a first mate chip, named by its department if it has one, else by
     its own name. WP-218 adds real departments; here, read the memberships that exist.
   - Last: "+ Add a department", which opens the existing "add a Mono to this project" flow until WP-218.
5. **First mate on the side.** Tapping a chip replaces the glance column with that first mate's panel; × or tapping the
   chip again closes it. The panel has tabs:
   - **Chat**: the first mate's own chat (the Lead's chat for Coding), with its composer and one grey line under the
     box ("Coding on <model> · crew on <model>", from the Crew defaults);
   - **Crew** (with a count): each of its workers, newest first, with a state chip (Stopped red, Working blue, Done
     green), the task in a few words, and a grey line with its pull request number, checks ("3 checks failing",
     "checks green") and the time running or tries made; clicking one opens the worker's chat read-only, with Stop;
     a footer line "Workers run on <model>. Change it in Crew rules." linking to Settings › Crew;
   - **Changes** and **Files**: the existing diff and file panels.
   Which panel is open is remembered per project.
6. **The glance column** (the right column when no first mate is open), boxes in this order, each hidden when empty
   except Working now:
   - **Needs you** (red, with the count from `needsCount(project)`): the top three items as sentences, each opening its
     source; "See all" opens Decisions filtered to this project;
   - **This week**: three numbers from the project's existing data (shipped pull requests, open pull requests, spend
     against its limit from WP-176). No number without a real source: leave a number out rather than invent one;
   - **Working now**: one line per first mate with what its crew is doing, in a few words;
   - **Decided for you**: today's count and the last two, each "<who> <what>". Until WP-211 and WP-215 record levels,
     read answered decisions not answered by the person; when there are none, hide it;
   - **Tasks** (open count), **Pages** (count) and **Other chats** (count), each opening its list.
7. **Home, the same shape.** After WP-212 lands, move Home's Needs you, Working now and Done today sections from under
   the chat into the same glance column (Needs you, Today: one line per project, Decided for you, then Tasks, Notes,
   Pages). The chat keeps the middle. Nothing else changes in WP-212's chat.
8. **No second sidebar on a project's home.** The project sidebar (Coding team, Tasks, Leadership team, Dashboards)
   goes in the Hub bundle: its parts live in the chips and the glance column. On Home the sidebar keeps Search, Tasks,
   Notes, Pages, Routines (today's Automations), then Monos and Groups.
9. **Names, not paths.** A chat, worker or session row shows the project's name, never its folder path. A project has
   one name everywhere: the rail tile, the header, Home's lines and Needs you all show the project's own name, cut with
   an ellipsis by CSS when long. Initials go only inside the tile's square. Today the rail says "Hub" and "Recall
   Check" while Home says "MonoCode Hub" and "Recall Checker".
10. **Off the main screens:** model chips, git line counts and sub-chat lists leave the project's home and Home; they
    stay in the side panel's Crew tab and on the Agents page.

## Done when

- [ ] Tests:
  - the rail lists only Home, projects, +, Agents, Decisions and Settings in the Hub bundle; a tile's badge equals
    `needsCount`, its dot follows `workingCount`, and Decisions' badge equals the whole list's count;
  - opening a project opens (or makes once) its Chief of Staff session in the project's folder; a second open reuses
    it; Home's session is a different one of the same Mono;
  - the old ways in (project row, "Coding team", "<Project> lead") all land on the project's home with Coding open;
  - chips: one per first mate from the project's Lead and memberships, none twice;
  - the side panel's Crew rows come from the project's delegations; the open panel is remembered per project;
  - every glance box hides when empty (except Working now) and its counts equal WP-210's;
  - no session row renders a folder path where a project name exists;
  - the Autopilot switch reads and writes the existing setting, default unchanged.
- [ ] Browser spec `tests/browser/wp213-project-home.spec.ts` with example data matching `Project.png` and
  `FirstMate.png`: the rail, the header, the chips, opening and closing a first mate (and remembered), each glance box
  opening the right place, and Home in the two-column shape, with 1440 × 900 screenshots.
- [ ] Before and after screenshots in the PR (example data), and the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-213/`, never pushed).
- [ ] `npm run check` passes.
