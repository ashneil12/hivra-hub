# Hub frontend: handoff notes for Claude Code

All hub data comes through `model/hubData.ts` (`hubData()`, `setHubDataSource`).
The app ships clean and reads **Ash OS** (live source, below). The example data
(`model/mockData.ts` and the per-page mock stores, labelled "Example:") answers
only behind the dev flag `monocode:hub-examples` (what `hub-dev.html` sets).

## Live data from Ash OS (unit 0, app side)

**Wired:** projects (strip, names, shapes, folders), Needs (shown, Later, ticks),
Since (text, time), Ash's last-active time (`ash-hub-active`), and the live
change feed. **Not wired yet** is listed below.

How it fits together (all new code under `src/features/hub/model/` unless noted):
- `src-tauri/src/hub.rs` is the Rust plugin `hub`, the only door to Ash OS:
  `hub_call(action, payload)`, `hub_events_open(after)`, `hub_events_close()`.
  It reads Ash OS's key from `~/.local/share/exo-cc-studio/token` on every call
  (Ash OS writes a new one at each start), sends only `ash-hub-<name>` actions
  to `127.0.0.1:18767`, and returns errors as `{kind, message}` in plain words.
  The key is never given to the webview (CSP also blocks the webview from
  reaching Ash OS; `hubWebviewGuard.test.ts` keeps the front end free of the key,
  the address and any direct fetch). The feed is server-sent events re-emitted as
  Tauri events `hub:event` / `hub:state`, reconnecting at 1, 2, 4, 8 then every
  15 s; windows share one feed. Registered by `.plugin(hub::init())` in `lib.rs`;
  its three permissions come from `build.rs` (an inlined plugin) and
  `hub:default` in `capabilities/default.json`. No Keychain commands (unit 7b).
- `hubTransport.ts`: the TypeScript end (`tauriHubTransport`) behind a small
  `HubTransport` interface, so everything below is tested against a stand-in.
- `hubStore.ts`: one `HubStore` read with `useSyncExternalStore`. Starts when the
  first screen subscribes, stops a second after the last leaves. First read is
  projects + Needs, then Since; after that the feed names what changed
  (`topics`) and only that slice is read again, folded into one round at most a
  second apart (Ash OS's feed also reports every ledger write). Feed down: a
  quiet check after 3 s and a poll every 30 s. `hub.code.version` or `reset`
  (Ash OS restarted or its ledger was restored): read everything again.
  Ash OS down: status `unreachable`, retried quietly at 3, 5, 10, 20, then every
  30 s, plus the Try again button. Stale data is kept while it is down.
- Rows update in place. `mergeStable`: a Need that is still there keeps its
  place, a new one joins at the bottom of its group, one answered anywhere
  becomes a tick where it stands (`state: "done"`, not counted, not using one of
  the 5 slots) and goes once Ash leaves the page (`dismissDoneNeeds()`, run when
  the selection changes). A row Ash OS lists as done that this session never
  showed open is not shown.
- `liveHubData.ts`: the `HubDataSource` the screens read. `hubData()` returns it
  unless the examples flag is on. Components that read `hubData()` while
  rendering call `useHubDataVersion()` (it also starts the store).
- `hubActivity.ts`: real use only (key, pointer, wheel, touch, window focus;
  ignored while the window is hidden). Reports the time of the latest input to
  `ash-hub-active`, at most once a minute, never from a timer, so an idle open
  window changes nothing. The first input after a 30-minute gap is reported at
  once; Ash OS decides what counts as leaving and sets "Since".
- Timestamps are ISO from Ash OS (`Need.since`, `doneAt`, `sinceAt`,
  `lastActiveAt`). `sinceLabel()` formats them. Mock stores for builds, chats
  and jobs still hold display strings; they are not wired.
- Look is unchanged. New states only: the "Ash OS isn't running." panel with one
  Try again button (shown instead of Today when the live source is down, never
  example data), a blank page while the first read is on its way (so "No
  projects yet." doesn't flash), and the tick on a Need answered elsewhere.
- A project with no code folder (`folder: null`, e.g. the harness) has no Coding
  team: its strip button opens its Inbox and the sidebar skips Coding team.
- Projects made on this Mac through the New project flow (not wired yet) stay on
  the strip next to Ash OS's list (`userProjects()`), as before.

### Run it against the stub (no Ash OS needed)
`scripts/hub-stub-server.mjs` answers the documented shapes with invented data
(every title starts "Example:"): same token, Host and Origin checks, poll, long
poll and server-sent events.
```
node scripts/hub-stub-server.mjs --port 18868 --dev        # --dev adds CORS + /__stub/control for the dev page
pnpm dev                                                    # vite on :1420
open "http://localhost:1420/hub-dev.html?stub=http://127.0.0.1:18868"
```
`?stub=` makes `browserTauriMock` serve `hub_call` and the feed from the stub
through the app's own `invoke`/`listen` code (`src/dev/hubStubBridge.ts`). Without
it, `hub-dev.html` shows the examples as before. `?stub=http://127.0.0.1:1`
shows the "isn't running" state. Move things while it is open:
`curl -XPOST localhost:18868/__stub/control -d '{"op":"doneNeed","id":"q5"}'`
(ops: `doneNeed`, `addNeed`, `setSince`, `finishPendingSince`, `restart`).
`scripts/hub-wiring-screens.mjs <dir> [--before]` takes the screenshots.

### Run it against the real service
1. Ash OS must be running a build with the hub calls (branch `ash-os-hub-core`
   landed). Until then the running service answers "Unknown hub action" and the
   app shows the "isn't running" panel.
2. `pnpm tauri dev` (or the built app). Nothing to configure: the plugin finds
   the key itself. To aim the plugin at another local port or key file (for
   example the stub started with `--token-file`): `MONOCODE_HUB_PORT` and
   `MONOCODE_HUB_TOKEN_FILE`. The host is always 127.0.0.1.

### Tests
`pnpm test` (vitest): `model/hubStore.test.ts` (store against the stub over real
HTTP and SSE), `hubActivity.test.ts`, `hubTransport.test.ts`,
`hubContract.test.ts` (the real `ashos.hub.Hub`'s own answers in
`model/fixtures/ash-os-real-shapes.json`, made by `scripts/hub-real-shapes.py`;
the store reads them and the stub invents no field), `ui/HubSurface.live.test.ts`
(Today and the strip rendered live). Rust: `cargo test --lib hub::` in `src-tauri`.

### Not wired yet (their mock paths stay behind the examples flag)
- **Jobs and the stuck state machine** (Being built, stuck and "gave up" rows,
  Sent to lead): Ash OS has no `hub_jobs` yet; `listStuck()` is empty.
- **Group chats** and the chat engine (`hubChats.ts`), Today's chat box.
- **Builds & playtests** (`hubBuilds.ts`, "only Ash marks played").
- **Connectors** and the Keychain (`connectors.ts`): Ash OS's `setup` list is
  shown read-only (no Sign in button yet).
- **Sections, templates, proposals, Changes, Bot changes** (`templates.ts`,
  `proposals.ts`): local mock stores.
- **New project, Create, setup export/import**: still local (`addMockProject`);
  `ash-hub-project-create` exists in Ash OS but the preview step does not.
- **Needs buttons** do nothing yet (`need-act`, `gate-done`, the options sheet
  are not in Ash OS yet). **Show details** is not rendered (`details` is read
  into the store, not shown). **Later** is a count, not a list.
- **Monos rail by membership** (`ash-hub-mono-projects`) and `ASH_MONO_ID`
  identity: Monos still come from MonoCode's own roster.
- **Needs for projects the registry doesn't list** (Ash OS files unrouted ones
  under project `inbox`): they are in the store but no screen shows them.
- Capture hook, heartbeat for the doctor banner, keep-alive and launch at login.
- Not verified: the plugin inside a running Tauri window (see the report).

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

## Restore preview, bots and connectors (unit 6c)
- A clean launch shows only the app's own **Lead** in the Monos list
  (`model/builtInMonos.ts`). The dev page seeds our example Monos only behind
  the example flag.
- Setup file (`model/setupFile.ts`) now also carries `bots` (name, role,
  project, team, skills count) and `connectors` (which services; never
  passwords or keys). Example file: `/workspace/hub-spec/build/example-setup.json`.
- Restore preview (`ui/RestorePreview.tsx`), used from onboarding, the empty
  Today and Settings → Dashboards, shows projects and templates, bots grouped by
  project and team (all ticked; expand a group to untick single bots), and
  connectors marked "Sign in after restore". Nothing is added until Restore.
- **First items for the technical talk with Claude Code:** real bot import
  (souls, skills, memory, sessions into Monocode's Mono store and teams) and
  real connector auth (OAuth/keys per service, stored only in the keychain).
- Connector sign-ins are **app-wide**. They sit in one "Setup" group at the
  top of Today (`setupItems()`), are never filed under a project, never add to a
  project's strip count, and go away once signed in. On Today, sidebar Monos are
  grouped by project under quiet headers (`hubMonoGroup`, `MonoRailSection.groupBy`).

## Decisions from the technical talk (2026-10-14)
See /workspace/hub-spec/SPEC.md, the section "Decisions 2026-10-14". Agents are separate, with per-agent update files and only the Lead writing the board; temporary workers show only in Being built; live updates must stay calm.

## Locked 2026-10-14 23:58
See the end of /workspace/hub-spec/SPEC.md for the locked decisions and the queued frontend rework.
