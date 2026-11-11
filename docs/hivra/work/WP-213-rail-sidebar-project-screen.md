# WP-213: Rail, sidebar and the project screen

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | L | WP-210 | yes |

## Goal

The rail holds places only. The sidebar follows the place you're in. A project opens on its coding team chat, with a
header that shows its counts and its Autopilot switch, and a Crew panel on the right that shows every worker, its pull
request and its checks. It matches [ux/mockups/Project.png](../ux/mockups/Project.png) and the rail and sidebar in
`Main.png`.

## Why

In 0.16.15 the rail mixed app sections (Home, Autopilot, Hub) with projects. "Hivra lead", "Coding team" and the
project row were three ways into one screen. Tasks in a project's sidebar couldn't be clicked. Sessions showed
folder paths in place of project names. Nothing showed what the coding team's workers were doing.

## Read first

- [UX.md](../UX.md) "Three places", [ux/mockups/Project.png](../ux/mockups/Project.png), `Main.png` (the Home
  sidebar).
- `hub/ui/ProjectStrip.tsx` (the rail), `app/shell/Sidebar.tsx`, `app/shell/MonoRailSection.tsx`, the project rail
  sidebar (`HubProjectItems`: Coding team, Tasks, Leadership team, Dashboards), `hub/model/leadRoleName.ts`.
- The Autopilot page and its setting store (the switch moves; the setting and its default don't change).
- The Crew settings and defaults (WP-141, PR #194 open: read only from it, don't change Settings › Crew), and the
  existing worker cards (`monos/ui/StuckWorkerCard.tsx`, `SubChatList.tsx`, `DelegationNotices.tsx`).
- Collisions: PR #201 (Autopilot) and #194 (Crew) are open. Merge `main` often and keep your hooks small.

## Build

1. **The rail.** It holds, from the top: Home, one tile per project (initials, the name under it, the red
   `needsCount(project)` badge, a small blue dot while `workingCount(project)` > 0), and **+** to add a project.
   **Settings** sits at the bottom. Remove the Autopilot and Hub tiles in the Hub bundle (`IS_HUB_BUNDLE`; upstream's
   rail is untouched). Project groups on the strip and "Show only this group" (WP-137, `hub/model/stripGroups.ts`) stay
   as they are: they arrange projects, so they belong on the rail.
2. **The Home sidebar** (when Home or anything app-wide is open) holds, in order:
   - Search;
   - Needs you, with its count (it opens the Inbox until WP-211, then the Needs you screen);
   - Tasks, Notes, Pages and Automations;
   - **Monos**, each with one line of what it is doing now, red when it needs Ash;
   - **Groups**.
3. **The project sidebar** (when a project is open) holds, in order:
   - the project's name, and its folder in grey;
   - **Coding team**, with "2 need you · 4 working" under it;
   - **Tasks**, with its open count, which opens the project's task list (today the row can't be clicked);
   - **Pages**;
   - **Monos on <project>**;
   - **Chats**, the project's other chats newest first with a short age, and "+ New chat";
   - **Groups**.
4. **One Coding team entry.** "Hivra lead" (a Lead's contact), the Coding team row and the project row all open the
   same coding team chat. A project's Lead is the coding team, so it isn't listed again among Monos or contacts. Its
   name on screen is "Coding team", and the header's grey line says "<Project>'s lead plans the work and runs the
   workers".
5. **The project header** is a single row above the coding team chat:
   - "Coding team";
   - the grey line;
   - a red chip "N need you", which opens Needs you filtered to this project;
   - a blue chip "N working", which opens the Crew panel;
   - on the right, an **Autopilot** switch for this project.
   The switch reads and writes the same per-project setting the Autopilot page does today, shows the real state, and
   changes no default. Autopilot stays off on the daily app until Ash turns it on.
6. **The Crew panel** is a right-hand panel with three tabs: Crew, Changes and Files. Changes and Files use the
   existing diff and file panels.
   - **Crew** lists each worker of this project, newest first. Each shows a state chip (Stopped in red, Working in
     blue, Done in green), its task in a few words, and a grey line with its pull request number, checks ("3 checks
     failing", "checks green") and the time running or the tries made.
   - A footer line comes from the Crew defaults: "Workers run on Grok. Change it in Crew rules." The link opens
     Settings › Crew.
   - Clicking a worker opens its chat.
   - The panel can be closed. Whether it is open is remembered per project.
7. **The composer** in the coding team chat shows one grey line under the box: "Lead: <model> · Workers: <model>",
   from the Crew defaults.
8. **Names, not paths.** A chat, worker or session row shows the project's name, never its folder path. The folder
   shows only in the project sidebar's header. A project has **one** name everywhere: the rail tile, the sidebar,
   Home's tags and Needs you all show the project's own name, cut with an ellipsis by CSS when it's long. The
   2-letter initials go only inside the tile's square. Today the rail says "Hub" and "Recall Check" while Home says
   "MonoCode Hub" and "Recall Checker".
9. Autopilot's log moves to Settings › Autopilot (WP-214 regroups Settings; here, only link it from the switch's menu).

## Done when

- [ ] Tests:
  - the rail lists only Home, projects, + and Settings in the Hub bundle;
  - a tile's badge equals `needsCount` and its dot follows `workingCount`;
  - the three old ways into the coding team open the same chat;
  - a Lead isn't listed twice;
  - the Autopilot switch reads and writes the existing setting, with its default unchanged;
  - the Crew panel's rows come from the project's delegations;
  - no session row renders a folder path where a project name exists.
- [ ] Browser spec `tests/browser/wp213-project-screen.spec.ts` with example data matching `Project.png`. It covers the
  rail, the project sidebar, the header chips (both open the right place), the Autopilot switch, and the Crew panel
  (open, close, remembered), with a 1440 × 900 screenshot of each.
- [ ] Before and after screenshots in the PR (example data), and the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-213/`, never pushed).
- [ ] `npm run check` passes.
