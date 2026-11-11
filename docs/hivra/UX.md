# Hivra's screens: the one model

Every screen follows this from 11 Nov 2026. Packages WP-210 to WP-214 (Wave N in [PLAN.md](PLAN.md)) build it. A UI
change that doesn't fit this model is reviewed against it and sent back.

**Why:** Ash, 11 Nov, looking at 0.16.15's Home: "visually nothing makes sense", and "home doesn't even work ...
right now there is no ux at all". Each package added its own corner of the screen, and nobody owned the whole. The
result was a Home that said "All quiet." under a red Needs you, three ways into the same coding team, an Inbox that
showed someone else's GitHub repo, a Home chat box that filed questions as tasks, and counts that disagreed.

**Updated the same day (Ash, 11 Nov 05:33): the captain model.** Ash owns the ship. The Chief of Staff is its captain:
the default agent, the one he talks to, shaped to his personality and learning him, on whatever engine he picks. First
mates run departments (Coding, Marketing, Ops and his own), and crew work under them. "The main interface is a chat":
Home and every project open on the Chief of Staff's chat, with what matters at a glance beside it. "The captain ...
makes 95-99% of all decisions for you": first mates and crew settle most decisions, the captain most of the rest, and
about one in a thousand reaches Ash. Sub-chats stay out of sight except on the Agents board, which is on by default.

Mockups, with example data: [ux/mockups/](ux/mockups/) (`Main.png` Home, `Project.png` a project's home,
`FirstMate.png` a project with its Coding first mate open on the side, `NeedsYou.png`, `Model.png` this page in one
picture; the `.html` files open in any browser).

![Home](ux/mockups/Main.png)

## The chain of command

| Level | Who | Decides | Passes it up when |
| --- | --- | --- | --- |
| Owner | Ash | Red lines, money past his limit, anything public or sent in his name, keys, anything that can't be undone, and taste calls with no history | Never: his decisions come batched, each with the captain's pick |
| Captain | The Chief of Staff | Priorities across departments, and anything his rules, standing answers or learned preferences cover | One of the owner's kinds above, or a new kind of call it can't predict his answer to |
| First mate | A department's lead (today: a project's Lead, the coding team) | Everything inside its department: order of work, which crew, retries, merging on green, spending inside its budget | It crosses departments, needs more than its budget, touches a red line, or isn't confident |
| Crew | Workers a first mate starts | How to do its own task | The brief doesn't cover it, the same check fails twice, or it reaches outside its task |

The target, measured from the decision records: of every 1,000 decisions, about 900 settled by first mates and crew,
about 99 by the captain, about 1 by Ash. The captain answers in this order: a rule Ash set; a standing answer (WP-156);
a learned preference; a confident first mate's recommendation; otherwise it asks Ash, batched, with its pick marked.
Every decision made for Ash is recorded with its level and reason and can be overturned in one tap; an overturn is
learned.

## The places

| Place | What it is | What it is not |
| --- | --- | --- |
| **Home** | The Chief of Staff's chat across everything, with an "At a glance" column beside it: Needs you, Today (one line per project), Decided for you, next routines. WP-212 builds the chat and the sections stacked; WP-213 moves the sections into the column. | Not a list of projects (the rail is that list). Not a dashboard of counters. |
| **A project's home** | The same Chief of Staff, in this project's own session of it (same Mono, same memory, scoped to the project). Above the chat, one chip per first mate with a status word. Beside it, the glance column: this project's Needs you, its dashboard (a few numbers from its Pages), Working now (one line per first mate), Decided for you, and Tasks, Pages and Other chats. | Not the coding team's chat (that opens on the side). Not three entries into one screen. |
| **A first mate, on the side** | Tap a chip: that first mate's chat opens in place of the glance column, with tabs Chat, Crew (its workers, pull requests and checks), Changes and Files. | Never its crew's chats; those are on the Agents board. |
| **Agents** | The whole tree, on by default: Chief of Staff, first mates, crew. State, cost, time, pull requests, checks. Any chat opens read-only, with Stop. | Not a place to manage work; the chats are. |
| **Decisions** | What needs Ash (the one list) on top; then Decided for you, newest first, each with who, why and Overturn; then his own past answers. | Not Settings. |
| **Settings** | Only settings, in about twelve groups, including the Chief of Staff's personality and engine, Ash's limits and red lines, departments, and "What I know about you". | Not a home for things you look at. |

The rail (the strip on the far left) holds places only: **Home**, one tile per project, **+** to add a project, then
**Agents**, **Decisions** (its red count is the whole Needs you list) and **Settings** at the bottom. A project tile
carries a red count (its Needs you items) and a small blue dot while any of its workers is running. Nothing else goes
on the rail: Autopilot, Hub, Inbox and app sections leave it.

There is no second sidebar on a project's home: its Tasks, Pages and other chats are the last box in the glance
column. On Home the sidebar keeps Search, Tasks, Notes, Pages, Routines, then Monos and Groups.

## One list: Needs you

Stopped workers, questions, approvals, failed Leads, gate and delivery checks, work ready to merge, and review requests
on Ash's own repos all go into **one list**, built in one place (WP-210). Every number on screen counts that list:

- the red count on a project's rail tile;
- the Needs you count in the Home sidebar and the Needs you section on Home;
- the Needs you box in a project's glance column;
- a Mono's red line in the sidebar;
- the Decisions place (WP-211) and its filter chips, and the Decisions count on the rail.

Once the captain decides at its level (WP-215), the list holds only what it passes up to Ash; what the captain or a
first mate settles goes to **Decided for you** instead, never to Needs you.

Because every number counts the one list, they always agree. Answering an item anywhere (Decisions, Home, the chat it
came from) removes it everywhere at once. Nothing says "All quiet" while the list has anything in it. Before this, about twelve pieces of
code each decided "needs you" on their own (`todayCounts.attentionCount`, `waiting.waitingCount`, `inboxCountNote`,
`home/model/lines`, the Inbox dot, `needsYouRows` for workers only, and more), and that is why the screens contradicted
each other.

## One name for each thing

| Before | From now on |
| --- | --- |
| Inbox (a GitHub feed for someone else's repo) | **Needs you**. Review requests on Ash's own repos join it. |
| "Hivra lead", "Coding team" and the project row: three ways into one screen | The project opens on its **Chief of Staff** chat; the coding team is the **Coding** first mate, one chip, one side chat |
| "Monos on <project>" | **First mates**: one chip each, named by department |
| Automations, habits, reminders | **Routines** |
| Settings › Decisions, the Inbox's decisions | **Decisions** |
| Dashboards, the Agents page, "Edit Today" | **Pages** |
| Waiting on you, Asking you, Waiting for you | **Needs you** |
| Being built, Moving now, jobs | **Working now** |
| MonoCode and MonoCode Hub in the app's own text | **Hivra** (the bundle and data folder change only with the rename, WP-07 step 2, last) |
| Raw ids (`chief-of-staff`), folder paths in place of project names | **Names**, always |

The wording rules Ash set in PM rounds r30, r30c and r57a still hold: never the word "Stuck"; a stopped worker is a red **Needs you** with one plain
reason and one button; waiting kinds are grey; no amber on the rail or sidebar.

## What goes away

- Autopilot and Hub tiles in the rail. Autopilot becomes a switch in each project's header; its log moves to Settings.
- The projects list on Home. The rail already is that list.
- Home's pretend chat that filed questions as tasks (`askChief` in `chief/model/answer.ts`). The real Chief of Staff
  Mono answers instead, and hands work to the right project's first mate.
- Loose "Move up", "Hide" and "Pin a panel" text on Home. One **Customize** button holds them.
- Badges counted from placeholder data (`hubBuilds`, `hubWork` and `proposals` mocks), Ash OS leftovers, the update row
  that has no update server, and upstream's GitHub star prompt.
- The Automations gallery of someone else's templates. It starts from Ash's projects and Monos instead.
- Emoji reactions that look like buttons, and usage lines repeated in three places. Usage lives once, in the status
  bar at the bottom.

This replaces WP-73 rule 6 ("no counters, badges or status chips"): there is now exactly one kind of count, the red
Needs you count from the one list, plus the "working" count beside it. Nothing else is counted.

## Rules for every screen

1. **Plain words a person would say.** A row reads as a sentence: "frank wants to run `npm publish`." Not ids, not
   paths, not field names.
2. **One action per row, maybe two.** The primary action is the blue button; the other is grey. A row never has more
   than three buttons.
3. **Every number comes from the one list or the working list.** A new count anywhere needs a new kind in WP-210's
   list, not its own query.
4. **Empty means hidden.** A section with nothing in it doesn't show. Home with nothing at all shows the Chief of
   Staff's chat and one line: "Nothing needs you."
5. **Example data in tests says so.** Seeded rows in specs start with "Example:" as today, so a screenshot can't be
   mistaken for Ash's real state.
6. **Dark theme first,** in the app's existing tokens; the mockups' greys and the red `#e5484d` / blue `#3b82f6`
   are the targets. No new colours without a reason in the PR.

## How a UI change is checked

A test passing is not the check; looking at it is. Every PR that changes something a person sees:

1. **Before and after screenshots at 1440 × 900** of each screen it changes, from a browser spec with seeded example
   data (`tests/browser/`, `page.screenshot`). Commit them under `docs/hivra/work/shots/wp-<NNN>/before/` and
   `after/` with the same file names, so a reviewer can put each pair side by side. They hold example data only.
2. **The same screens in a dev copy** (`npm run hub:dev -- --seed`, a cleaned backup of Ash's chats). These hold Ash's
   real chats, so they **never go to GitHub** (the repo is public). They stay on the Mac under
   `~/Worktrees/ux-shots/<WP>/before|after/`, and the PR says where.
3. **The integrating Claude looks at both against the mockups and this page** before merging, and writes what it
   checked in the PR (screen by screen: matches, or what it sent back). Counts on every screen in one shot must
   agree with each other.
4. A screenshot that shows "All quiet" beside a red count, two names for one thing, a raw id, or a button that does
   nothing is a FAIL whatever the tests say.

## Order

1. **WP-210** One Needs-you list, first: everything else reads it.
2. **WP-212** Home with the real Chief of Staff, beside 210.
3. **WP-213** Rail and the captain-first project home, with first mates on the side.
4. **WP-215** The captain: the Chief of Staff's charter, routing to first mates, deciding at its level.
5. **WP-211** The Decisions place: Needs you, Decided for you with Overturn, past answers. After the open Inbox packages
   (#213 secret vault, #220 security review, #225 standing answers) land, because they touch `FirstMateInboxPanel`.
6. **WP-216** First launch, the owner batch ("1b 2a"), calibration questions and "What I know about you".
7. **WP-217** The captain's rounds and routines: the hourly sweep, the morning brief, routines from repeats.
8. **WP-218** Departments beyond coding, each with its first mate and budget.
9. **WP-219** The Agents board as the one place for the whole tree.
10. **WP-214** Words and leftovers, last: it renames across everything the others built.
