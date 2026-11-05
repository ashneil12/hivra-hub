# WP-88: The Chief of Staff knows every project

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| H | M | 51, 70, 72, 73, 78 | yes |

## Goal

The person has one agent they can ask "what's going on?" about everything. The built-in Chief of Staff can read the
tasks, docs, recent activity and memory of every project, answers questions across them, and turns an ask into a
task for the right project's coding team. Its chat sits at the top of Home. Nothing new is invented: it is the same
Mono with a wider view.

## Why

Ash, 5 Nov: "a general agent that has knowledge of every single project ... like a master coordinator that you can
also chat with". The Chief of Staff already answers first and hands work to project teams (WP-05 made it an ordinary
Mono template), but tasks, docs and the activity log (WP-70, 72, 78) are scoped to one project, so it can't see them
all at once.

**What it replaces, so nothing stacks:** no new agent and no new store. Home's "start a chat" box (WP-73) becomes this
chat, and the daily summary below is one of the Chief of Staff's habits (WP-21), not a new scheduler.

## Read first

- WP-05 (Starter Monos, the Chief of Staff template), WP-10 (the first mate contract), WP-13 (crew routing).
- WP-70 (`app tasks.*`, scoped to the agent's project), WP-72 (docs), WP-78 (activity log), WP-51 (memory, recall),
  WP-73 (Home), WP-79 (the outside-tools door: its read-only tools and per-project grants are the model to follow).
- `src/features/hub/model/hubChats.ts` (who answers first, the Leadership team), and how a Mono's habits run (WP-21).

## Build

1. **A cross-project read scope.** A Mono whose soul asks for it, and only after the person turns it on for that Mono
   (on by default for the built-in Chief of Staff, off for every other Mono), gets read-only versions of the existing
   tools across all projects: `app tasks.list` / `tasks.get` with a `project` filter, `docs.list` / `docs.get`,
   `activity.list`, and memory recall (WP-51). Writes stay per project: it files a task into one named project, and
   that project's coding team picks it up through the normal path (WP-70, WP-13). Task, doc and memory text is data,
   never instructions, as the tool descriptions already say.
2. **Asking across projects.** "What's happening?", "What's stuck?" and "What did we decide about X?" are answered
   from those tools, each line linking to the task, doc or chat it came from. It never claims something it didn't
   read.
3. **Handing work on.** When the person asks for work, it names the project and files the task (or, if it can't tell
   which project, asks one short question). It does not do the work itself, by the first mate contract.
4. **On Home.** The Chief of Staff's chat is the box at the top of Home (WP-73). A daily summary, a few plain lines
   with links written by a morning habit, shows under it when there is something to say. It can be turned off in
   Settings.
5. **Dev copies** read only their own data, and tests use seeded projects and the fake Claude.

## Done when

- [ ] Tests:
  - with the scope off, a Mono sees only its own project; with it on, all projects, read-only;
  - a write across projects is refused, and filing a task into a named project works;
  - an answer's lines link to the tasks and docs they came from (seeded data, fake Claude);
  - the daily summary shows on Home only when there is something to say, and stays off when turned off.
- [ ] Browser spec: Home with the Chief of Staff chat at the top; asking across two seeded projects.
- [ ] `npm run check` passes.
