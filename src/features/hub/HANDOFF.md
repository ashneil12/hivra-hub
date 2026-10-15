# Hub frontend: handoff notes for Claude Code

All hub data comes through `model/hubData.ts` (`hubData()`, `setHubDataSource`).
The app ships clean and reads **Ash OS** (live source, below). The example data
(`model/mockData.ts` and the per-page mock stores, labelled "Example:") answers
only behind the dev flag `monocode:hub-examples` (what `hub-dev.html` sets).

## Live data from Ash OS (unit 0, app side)

**Wired:** projects (strip, names, shapes, folders; parked projects are left off
the strip), Needs (shown, Later as an opening list, `older` as a shut "Older (n)"
group in no count, ticks, Looks right marked seen), Since (text, time), Ash's
last-active time (`ash-hub-active`), jobs (Being built, amber Stuck rows, the red
"Needs you" row and its See options sheet), and the live change feed.
**Not wired yet** is listed below.

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

**The strip: Ash's four projects.** Ash (15 Oct): "i only need hivra, the game,
the harness n nibbii". `hubProjects.ts` keeps the strip to `vg-game`, `hivra`,
`nibbii`, `ash` in that order (EXO, Hivra, Nibbii, Harness; `ash` is named
"Harness"); other and parked projects are off the strip and off Today (their
older questions too). Projects are told apart by shape: on 15 Oct the live
service returned `iconShape: "folder"` for every project, so `distinctShapes`
gives each a stable distinct shape (the design's own for these four: EXO ghost,
Hivra sparkles, Nibbii palette, Harness gauge; any other id hashes into a free
shape). **Ash OS should own both** (the list and `iconShape`); once it returns
just these with distinct shapes, the app uses its shapes and the filter changes
nothing and can go.

**Ships clean.** Template sections (Builds & playtests, Users & emails) are only
listed with the examples flag: their screens are example data or the "built in
Unit N" placeholder, and the placeholder renders nothing without the flag. They
come back as each is wired.

**Since.** The paragraph is clamped to four lines and drops bracketed lists of
raw titles (`calmSummary`; Ash OS's plain fallback text quotes ask titles, which
is being fixed there). While `summary.pending` is true it shows a quiet
"Writing up what changed…" line; the paragraph swaps in place when
`hub.since.ready` arrives.

**Needs, Later and Older.** `Need.later` rows are under Later: the line "N more
under Later" opens them (`LaterList`). `older` (questions recovered from past
chats, backlog-sweep questions, failures no longer failing) is `snap.older`: not
Needs, so in no badge, count or cap, shown as "Older (n)" shut, once at the
bottom of Today (opened, grouped by project) and per project in its Inbox.
The strip badge is the project's real Needs count (shown plus Later, the number
Ash OS and the Since paragraph quote; `HubDataSource.needsCount`, kept live by
the feed); rows still show at most five plus "N more under Later". Older rows
and ticked rows never count. (With the examples flag the badge is still the
count of the waiting list.)

**One action per row, as Ash OS names it.** A Looks-right row whose
`actionType` is `accept` shows Ash OS's label (**Looks right**) and calls
`ash-hub-need-accept {id}` (app-only in Ash OS; being added there, proven against
the stub). A Looks-right row that still comes as action `open` (`s:<ask>`) has one
button, **Seen**, calling `ash-hub-need-seen`. Either way the row ticks off. A job the Lead gave up on is one row:
`CircleWord` (14px red circle, plain grey "Needs you") then **See options**.
That opens `OptionsSheet`: what was tried, then Try again tonight, Try it a
different way… (a hint box, Send), Pause this job, Drop it, from
`ash-hub-job-options`; the pick goes through `ash-hub-job-act`, the sheet closes
and the row ticks off. A refusal ("That job isn't waiting on you.") shows in
plain words and the sheet stays. See options on a **question** row
(`question:<id>`) opens `QuestionSheet` (`ash-hub-question` / `ash-hub-answer`,
branch `ash-os-hub-answer`; fixture `fixtures/ash-os-real-shapes-answer.json` from
that branch's code). Most questions have no options (127 of 145 open on 15 Oct),
so the sheet always shows the suggestion with **Go with this** (quick `agree`,
only when there is one) plus quiet **Not now** (`park`) and **Drop it** (`drop`);
options, when there are any, are rows to pick (the suggested one marked
"Suggested"); **Say something else…** takes his words; one **Send** sends the pick
and/or words. Sending closes the sheet at once and never blocks: the row says
"Sending…" (an option or typed answer is read by the model, up to a minute), then
shows the receipt, and ticks off only when Ash OS says `rowDone`. Until the branch
lands, the live service answers "Unknown hub action" and the sheet says Ash OS
needs its update. **Open** and **Start** rows open `DetailSheet` (title, why,
detail; no ids). A refused action (e.g. Looks right on work without evidence)
shows Ash OS's words under the row.

**Being built (jobs).** `snap.jobs` is `ash-hub-jobs` grouped under the Mono
running each job, in Ash OS's order, merged stably (`mergeJobGroups`): a job that
changes state keeps its row, a new one joins the end of its group. The feed's
`jobs` topic re-reads it. `liveJobs.ts` turns a job into the same row the example
data used (`workerOf`): Working and Checking quiet text; Stuck (job states
`stuck` and `sent_to_lead`) an amber circle, "Stuck", the reason on a second
line and "Sent to coding team lead at 2:20pm · Got it" on a third; Needs you
(`lead_gave_up`) the one pill badge; Done a dot until seen; Parked plain. The
"last active" label is counted from `lastActiveAt` against a clock that ticks
every 30 s (`useNow`), in fixed-width columns, so it changes in place. No helper
or worker is ever named. When Ash leaves the page the finished jobs he had in
front of him are sent to `ash-hub-job-seen` and go (React's dev double-run does
not count as leaving). Stuck jobs also appear on Today and the Inbox as amber
rows with no button (`StuckItem.quiet`); a given-up job is not among them, it is
the red Needs row. Clicking a job opens a small story built from what Ash OS
says (started, tried, sent, "got it"); there is no step log to show yet.
A service without `ash-hub-jobs` just means nothing is being built.

**Project Leads (`hubLeads.ts`).** In the Hub bundle (and on the dev page with a
stub or the live proxy), once Ash OS has listed the projects, each gets its Lead
Mono if missing: `vg-game-lead` "EXO lead", `hivra-lead`, `nibbii-lead`,
`ash-lead` "Harness lead". Each is tied to its project's folder (so the Coding
team's Monos rail shows it), gets a soul in Ash's words (orchestrator, his full
words to workers, `sonnet` workers, `ash_recall` first, `ash_dump` verbatim,
verify, Looks right only when critical, its identity), is written to
`<app data>/monos/<id>/SOUL.md` right away, and is registered in Ash OS as the
project's Lead (`ash-hub-mono-project-add`, role lead). Never re-made, renamed or
re-souled. A Lead's chats start in its project's folder (`monoWorkspace.ts`);
other Monos still start at home. Its Claude Code sessions get Ash's own `ash-os`
MCP entry (read in Rust, `hub_ash_os_mcp`, only that entry from `~/.claude.json`)
with `ASH_MONO_ID` / `ASH_ROLE=lead` in its env, through
`claudeExtraArgs.ts` (MonoCode registers nothing there). Claude Code gives MCP
servers only HOME, LOGNAME, PATH, SHELL and USER of its own env (checked on this
Mac with `claude mcp list` and `ps eww`), which is why the identity is in the
entry. Not proven: that Claude Code lets this `--mcp-config` entry replace the
user-scope `ash-os` entry of the same name (no session was started).

### The MonoCode Hub app (a separate bundle)
`src-tauri/tauri.hub.conf.json` builds **MonoCode Hub** (`com.ash.monocode-hub`)
next to Ash's MonoCode without touching it: its own name and bundle id, so its
own app-data folder (`~/Library/Application Support/com.ash.monocode-hub`) and
its own webview storage; no updater artifacts (the updater has no endpoints);
`VITE_MONOCODE_HUB=1` (`model/hubBundle.ts`, `IS_HUB_BUNDLE`) so it opens straight
on the hub (Today) with no onboarding, new chats start on Claude Code on its
first run (MonoCode's own fallback, Cursor, is untouched; a choice Ash makes
sticks), and the quick composer's panels are not pre-built offscreen at launch
(MonoCode pre-builds a hidden 'MonoCode' panel and a 'Choose workspace' popup;
the Hub builds them the first time the composer opens). On the hub's views the
"Harness update available" toast sits bottom-left over the sidebar instead of
over Today; it is still dismissible.
The data source is the live one (the examples flag is never set outside the dev
page), through the Rust plugin to 127.0.0.1:18767.
```
npx tauri build --config src-tauri/tauri.hub.conf.json --bundles app   # release; ad-hoc signed
cp -R "target/release/bundle/macos/MonoCode Hub.app" ~/Applications/
```
Build release, not debug: a debug build rewrites a dev bundle under MonoCode's own
id (`macos::ensure_dev_bundle`). Shared with MonoCode on purpose or by design:
Claude Code and the other harness CLIs it starts, Codex Mono migration folders in
the home folder, and the quick composer's global shortcut (if both apps register
the same one, the second fails quietly).

### Run it against the stub (no Ash OS needed)
`scripts/hub-stub-server.mjs` answers the documented shapes with invented data
(every title starts "Example:"): same token, Host and Origin checks, poll, long
poll and server-sent events.
```
node scripts/hub-stub-server.mjs --port 18868 --dev --jobs # --dev adds CORS + /__stub/control; --jobs adds leads and jobs in every state,
                                                            # a given-up job's red row, Looks right and older questions
pnpm dev                                                    # vite on :1420
open "http://localhost:1420/hub-dev.html?stub=http://127.0.0.1:18868"
```
`?stub=` makes `browserTauriMock` serve `hub_call` and the feed from the stub
through the app's own `invoke`/`listen` code (`src/dev/hubStubBridge.ts`). Without
it, `hub-dev.html` shows the examples as before. `?stub=http://127.0.0.1:1`
shows the "isn't running" state. Move things while it is open:
`curl -XPOST localhost:18868/__stub/control -d '{"op":"doneNeed","id":"q5"}'`
(ops: `doneNeed`, `addNeed`, `addJob`, `setJob`, `setSince`, `finishPendingSince`, `restart`).
`scripts/hub-wiring-screens.mjs <dir> [--before]` and `scripts/hub-jobs-screens.mjs <dir>`
take the screenshots.

### Look at the REAL Ash OS in the browser dev page
A browser can't read the key file, so `scripts/hub-live-proxy.mjs` stands in for
the Rust plugin: it binds 127.0.0.1, reads the key per request, adds it to
`ash-hub-*` calls and forwards them to 127.0.0.1:18767; the page never sees it
and nothing prints it. It is **read-only** by default (reads only; activity,
seen, job choices, owners and projects get a 403, so looking can't move Ash's
real "Since" time or touch a job); `--allow-writes` lifts that.
```
node scripts/hub-live-proxy.mjs          # :18869
pnpm dev
open "http://localhost:1420/hub-dev.html?live=http://127.0.0.1:18869"
node scripts/hub-live-screens.mjs <dir>  # screenshots of Today, Since and each project's Inbox
```
Writes (Seen, job choices) are proven only against the stub: nothing here has
pressed them on Ash's real data.

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
HTTP and SSE, including older, need-seen and jobs), `hubActivity.test.ts`,
`hubTransport.test.ts`, `liveJobs.test.ts`, `hubContract.test.ts` (the real
`ashos.hub.Hub`'s own answers: `fixtures/ash-os-real-shapes.json` from the live
code, `fixtures/ash-os-real-shapes-jobs.json` from the jobs branch (not live),
made by `scripts/hub-real-shapes.py` and `scripts/hub-real-shapes-jobs.py`; the
store reads them and the stub invents no field), `ui/HubSurface.live.test.ts` and
`ui/HubSurface.jobs.test.ts` (Today, Later, Older, Seen, the options sheet and
Being built rendered live). Rust: `cargo test --lib hub::` in `src-tauri`.

### Not wired yet (their mock paths stay behind the examples flag)
- **Jobs against the live service:** the code is wired and proven against the
  stub and the jobs branch's own answers, but `ash-hub-jobs` is not live yet
  (branch `ash-os-hub-jobs`): today Being built says nobody is working.
  `ash-hub-job-owner`, `-work-owner`, `-unreachable` (the app telling Ash OS a
  Lead's session could not start) are not called.
- **Group chats** and the chat engine (`hubChats.ts`), Today's chat box.
- **Builds & playtests** (`hubBuilds.ts`, "only Ash marks played").
- **Connectors** and the Keychain (`connectors.ts`): Ash OS's `setup` list is
  shown read-only (no Sign in button yet).
- **Sections, templates, proposals, Changes, Bot changes** (`templates.ts`,
  `proposals.ts`): local mock stores.
- **New project, Create, setup export/import**: still local (`addMockProject`);
  `ash-hub-project-create` exists in Ash OS but the preview step does not.
- **Question and gate Needs buttons** (See options on a question, Open, Start)
  still do nothing: Ash OS has no `need-act`, `gate-done` or question options.
  **Show details** is not rendered (`details` is read into the store, not shown).
- **Unsorted Needs** (`unsorted` in `ash-hub-needs`) are not read or shown.
- **Monos rail by membership** (`ash-hub-mono-projects`) and `ASH_MONO_ID`
  identity: Monos still come from MonoCode's own roster.
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
  Need (`laterItems`). There is no separate "waiting" state. Mock: Harness
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
  one flat list: default team, then project Leads (`hubMonoRank`, `MonoRailSection.rank`); workers only in Being built.

## Decisions from the technical talk (2026-10-14)
See /workspace/hub-spec/SPEC.md, the section "Decisions 2026-10-14". Agents are separate, with per-agent update files and only the Lead writing the board; temporary workers show only in Being built; live updates must stay calm.

## Locked 2026-10-14 23:58
See the end of /workspace/hub-spec/SPEC.md for the locked decisions and the queued frontend rework.
