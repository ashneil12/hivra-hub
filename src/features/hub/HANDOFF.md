# Hub frontend: handoff notes for Claude Code

All hub data comes through `model/hubData.ts` (`setHubDataSource`) and the
per-page stores in `model/` (mock data, labelled "Example:").

## One "waiting on Ash" list
- `model/waiting.ts` is the only list of things waiting on Ash. Each page adds
  its items through a provider there: Inbox (Needs and stuck items), Builds
  (failed builds that are stuck or gave up), Being built (stuck workers not
  already covered, linked by `Worker.waitingId`).
- The strip counts (`waitingCount`), Today, each project's Inbox and every
  "Take a look" button (chats, builds, being built) read only from it. Never
  count separately. A new page must add a provider, not its own count.
- At most 5 Needs per project (`MAX_NEEDS`).

## Builds: only Ash marks a build played
- "Played" is `Build.played = { by: "ash", at }`. It is set only by an action by Ash:
  `markPlayed(id, "ash")` (the "Mark played" button) or `addNote(id, text, "ash")`.
- The data layer rejects any other actor (`{ bot: id }` throws). The real
  backend must enforce the same: a bot or Mono can never set played, and the
  actor must be recorded as Ash.

## Self-change proposals (unit 5)
- `model/proposals.ts`: each pending proposal is one item in the waiting list
  (button "Preview" opens `proposal:<id>`). `applyProposal` refuses a proposal
  with `blocked` set: a change that breaks a design rule never goes live.
- Apply/Undo only change the proposal's status in the mock; the real
  edit-dashboard skill must perform and revert the actual change.
- Settings → Changes lists applied and undone changes with Undo.
- **Rule-breaking proposals never reach Ash.** The app turns them down
  automatically (`status: "rejected"`): not in the waiting list or counts, no
  proposal page. They appear only in Settings → Changes as "Turned down
  automatically: breaks "<rule>"" with the reason, and no Undo.
- **A valid proposal is a Need.** It shares the 5-Needs cap per project; when a
  project already has 5 Needs, the proposal goes under Later like any other
  Need (`laterItems`). There is no separate "waiting" state. Mock: Operator OS
  has 5 Needs, and its Hiring card proposal (p4) is under Later.

## Focus on 'Take a look'
- `HubSelection.focus` carries a refId; GroupChatView opens the conversation
  holding that message, scrolls to it and highlights it briefly.

## Dashboards and onboarding (unit 6)
- `model/templates.ts`: three templates (Game studio, Product / SaaS,
  Org / ops). Each one defines a project's Today cards and its sidebar sections.
  `listProjectItems` takes its sections from the project's template. A new
  project picks a template on the strip's '+' page (`NewProjectView`; mock: it
  adds an in-memory project and makes no folder).
- Settings → Dashboards: each project's template, Reset to default, and Export
  setup / Restore setup (a JSON file of `{projects: {id: {template}}}`). The real
  export should write one settings file per project (Glance model), including
  teams and Monos.
- Today cards are recorded per template but are not yet rendered card by card.
  Today still uses the fixed Since / waiting layout.
- First-launch onboarding (`HubOnboarding`, flag `monocode:hub-onboarded`) has 4
  steps and can be skipped. The theme step uses the same presets as Settings →
  Appearance and keeps glass on. On the dev page it shows only with `?onboarding`.

## Ships clean (Ash's call)
- First launch has **no projects**: only the three built-in templates. All our
  example data (projects, Needs, stuck items, chats, builds, workers,
  proposals) sits behind the dev flag `monocode:hub-examples` (`model/examples.ts`),
  which only the dev page sets.
- **Ash's own setup arrives via a setup file** (`model/setupFile.ts`, Settings →
  Dashboards → Restore setup, or step 2 of onboarding). The file carries the
  projects and their templates; it should grow to teams, Monos and sections.
- Onboarding step 2: "Start a new project" (goes to the New project flow after
  the theme step) or "Restore a setup file". A clean Today shows "No projects
  yet." with one New project button; the strip shows only Today and +.
- New project (onboarding skill, spec H5): name + template, three plain
  questions from the Chief of Staff, then a preview of the project as it will
  look (strip icon, sidebar, Leadership and Coding Monos, Today sections).
  Nothing is created until Create project. The answers are not yet sent to an agent.
- **To explore with Claude Code:** how agents can edit the setup (agent-editability),
  e.g. an agent proposing a change to a project's settings file, which then
  goes through the design-rules check and preview (unit 5).
