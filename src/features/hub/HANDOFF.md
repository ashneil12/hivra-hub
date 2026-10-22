# Update: 20 October 2026, one permanent home per Mono (branch cos/mono-homes)

Decided 20 Oct (Grok Bot leadership, from Alfred's audit: 14 sets of Mono folders on the Mac, the live leads on the 15 Oct
soul, chat ids only in WebView storage).
- **Where Monos live** (`src-tauri/src/mono_home.rs`, `mono.rs resolved_root`): the daily app keeps every Mono in
  `~/agent-memory/monos/<id>/` (SOUL.md, MEMORY.md, memory/, habits.json, chats.json, soul-template.md) with the roster in
  `MONOS.json`. Dev copies keep `<app data>/monos`; `MONOCODE_MONOS_HOME` names a throwaway home. The first daily launch
  copies (never moves) the old folder there, checked byte for byte, record in `.migration.json`; a clash stops it and the
  app keeps the old folder that session. Every write is checked before saving (`check_write`). Ship backs the home up as
  `monos-home/`.
- **Roster and chat ids** (`monos/model/monoHome.ts`): MONOS.json is durable, the WebView copy a cache, reconciled before
  the first render (a wiped WebView gets its Monos and chats back), then written through. Chat ids also go to
  `<id>/chats.json`.
- **Only the app writes there**: every hub chat is denied `Edit(~/agent-memory/monos/**)` (`hubMcp.ts`
  `monoHomeDeniedTools`), and worker and Lead briefs say it in plain words (`MONO_HOME_FENCE`).
- **Soul refresh** (`model/soulRefresh.ts`): a soul behind the app's template takes it on its own (Ash, 14 Oct: bigger bot
  changes apply themselves and never wait for a click), with the whole old soul saved in its memory first and a Bot changes
  row with Undo. His hand edits win. The row reads as one plain sentence per changed part (`SECTION_SENTENCES`, "Hivra
  lead will now ...") plus what was skipped for his edits; no diff, no paths. A soul with no recorded template (the
  live 15 Oct leads) is swapped only when it is exactly a soul the app once seeded (`knownSouls.generated.ts`, SHA-256s
  from git history: `node scripts/known-souls.mjs`, `--check` to verify); otherwise it is left alone with a plain row
  and no Undo ("Hivra lead's soul has your own changes, so the app's update was skipped. Ask Alfred to merge it if you want it.").
- **"Ask Alfred to merge it"** (`model/soulMerge.ts`, app actions `souls.read` / `souls.merge`): only Alfred's own chat
  (by Mono id; never a habit run, worker or other Mono) may merge another Mono's soul update. The app refuses a soul
  that changed since Alfred read it, a blank or non-soul text, any line that is in neither the soul nor the app's version
  (merge only, never add), and a merge that drops a part Ash added; then it saves the old soul, records the template and
  logs one plain row ("Alfred merged the app's update into Hivra lead's soul and kept your changes to 'Your job'.") with
  Undo and Redo. Alfred's soul has the matching section. The real-model scene ("merge hivra leads update") is for the
  conversation runner.
  The skipped row's "Ask Alfred" opens Alfred's chat with "merge Hivra lead's update" typed in, not sent
  (`monos/model/monoPrefill.ts`). The guard tries the roster's folder, the folder the soul names, and none, so a roster
  without folders no longer makes untouched leads look hand-edited; any other reason is said on the row.
- **Soul tamper check** (`model/soulTamper.ts`): every soul the app saves is recorded (hash and text, in the app's own
  storage: `monos/model/soulSaved.ts`, from `writeAgentFile`). At launch and whenever a Mono's files open, a soul that no
  longer matches is set against when chats were running (`monos/model/sessionRuns.ts`, from App's sessions; the file's
  change time comes from `mono_read`'s `modifiedMs`). A chat running then: the saved soul is put back, the changed file
  kept as `memory/soul-changed-outside-<time>.md`, row with "Keep that change". Nothing running: Ash's edit, kept and
  recorded, row with Undo. Known gap: a portable restore writes souls from Rust, so its souls show once as "edited
  outside the app" (kept, never put back unless a chat was running at that moment).
- **ash-lead is hub-lead** (`model/monoRename.ts`, `mono_rename`), once, old soul kept in `memory/ash-lead-soul.md`.
- **Chief of Staff's Grok Bot line** (`model/memoryLineFixes.ts`): "The hub runs on its own without Grok Bot. Grok Bot
  leadership can oversee it and set tasks, but isn't required."

# Update: 20 October 2026, teams, not sub-chats (branch hub/10-monoteams)

Ash, 20 Oct: "monos shouldn't really have sub chats, if its stuff to fix it should either do it itself or pick it up
with the coding team. IF they do need to do work ... then something like coding team should be created for that mono".
He tried the rail's sub-chats again as an option and went back: "It doesn't make any sense to have the rails" (the
optional-team build is reverted in history, d60c650a). Sub-chats only ever live in a team (a workspace with a Sessions
list); the Monos rail shows people, not work.
- **Where a Mono's work goes** (`agent-app/model/agentAppTasks.ts` `monoWork`, `model/monoTeams.ts`): a small fix the Mono
  does itself; a project's work goes to that project's coding team as a brief to its Lead (`delegate_task {lead}`), and
  every Mono but a Lead and the checker may brief (`leadershipDelegation.briefsLeads`; still only Leads of projects both
  are members of). A worker of its own in a project with a coding team is refused with that guidance. Its own work (no
  project) starts a worker in its own team. Leads and coding-team chats work as before.
- **A Mono's own team**: made the first time it hands out work of its own. Its folder is
  `<app data>/mono-teams/<mono id>` (`src-tauri/src/mono.rs` `mono_team_dir`): every copy has its own (daily app, each
  dev slot, the bench's HOME), beside `monos/` rather than in it (a ship backs up `monos/`; a team's output can be big),
  browsable from the team's Explorer. It is no repository: its workers share it, a worktree asked for there is refused,
  and the automatic checkout for a second worker never applies (the bench, 20 Oct: one was asked for, never made, and
  the worker never ran). Its rows carry the folder as their project (no hub project). Kept by Mono id
  (`monocode:mono-teams`); the Mono may read and steer sessions there (`monoOf.team`). Selected as `team:<mono id>` with
  no project (`hubNav.monoTeamItem`); the Sessions list (`Sidebar` `CodingTeamList` kind `mono`) pins the Mono's chat
  ("Owner") with its workers folded under it; "Team" beside Overview in its chat header toggles it; the folder is named
  "<Mono>'s team" and kept off the recent projects.
- **The rail** (`app/shell/MonoRailSection.tsx`): no sub-chat lists, a Lead's included. A Mono with nothing out shows
  nothing extra (at rest the rail is pixel-identical to hub/next's). Under a Mono with work out, one line ("2 working ·
  1 stuck", asking counted as stuck as on Today; red once one failed; the full split on hover) opens its team (a Lead's
  coding team, or its own; else its chat), as does "Open team" on the row (on hover, only while it has work out); its
  menu has "Open <team>" whenever it has a team.
- **A Mono's chat** (`monos/model/briefedTeams.ts`, `DelegationNotices.tsx` `BriefedTeamLine`): one live line per brief
  out ("Briefed EXO coding team: Fix the save bug · 2 working · 1 stuck", counting every worker beneath the brief), which
  opens the coding team on its Lead; the Lead's workers never show there.
- **Rules**: `<team_rules>` (`monoFiles.ts` `MONO_TEAM_RULES`) for every Mono with the delegate tool but a Lead;
  `<lead_brief_rules>` speaks to every Mono; the room's shared rules and ROOM.md say work started from the room goes to
  a team. `MONO_PROMPT_VERSION` 29.
- **Proof**: `tests/browser/mono-teams.spec.ts` (photographed), `stuck-workers.spec.ts` (sub-chats in the coding team);
  `hub:verify-live` checks 22 (`mono_briefs_coding_team`) and 23 (`mono_own_team`), read through the driver.
- **Not done**: `app sessions.start` is unchanged (the rules tell a Mono to use delegate_task): a Mono with no team of
  its own that still starts a session in a project with it gets a hidden chat that only its Overview's Sessions tab
  lists (upstream MonoCode's panel, kept); the rail still counts it and opens the Mono's chat.

# Update: 20 October 2026, the coding team (branch hub/8-codingteam)

Ash, 20 Oct: "mainly the coding team is the main place i want to talk to", "I don't talk to workers. I only talk to
orchestrators", "agents should chat as well not just do".
- **Coding-team chats are orchestrators** (`model/codingTeam.ts`): a top-level chat in a hub project's code folder (not a
  Mono, habit run, `app-` worker, throwaway, orchestration run, Inbox ask or automation) is noted by id before its
  turn (`monocode:coding-team-chats`). It gets the delegate tool and ASH_PROJECT (`hubMcp.ts` kind `team`; its workers
  inherit the project), app access every turn, and once per conversation `codingTeamContext` (`monoFiles.ts`: who it
  is, ask-Ash, talk, delegate, check and PR rules, the project's memory primer). `tasks.*` and `prs.*` take it, signed
  "<Project> coding team", on its own project only, never briefing a Lead. Reports, questions, Stop, PR wakes and stuck
  notifications route to it like a Mono (`monos/model/orchestrators.ts` `isOrchestratorChat`); what only a Mono has
  (soul, memory files, habits) still asks `isMonoSession`. Its pane shows the stuck cards and "2 working: API" line.
- **The Sessions list** (`app/shell/Sidebar.tsx` `codingTeam`, `model/codingTeamList.ts`): the project's Lead pinned on top
  (mascot, "Lead"), Ash's own chats below, every chat a chat started folded under it (`monos/ui/SubChatList.tsx`:
  "N sub-chats", opens by itself when one is stuck, asking or failed; one click opens one). Since hub/10-monoteams the
  Monos rail lists no sub-chats (above).
- **Navigation**: opening a Lead from anywhere lands in its coding team, beside the list (`onOpenMono`); picking a project
  or "Coding team" opens on the Lead unless Ash was last in another chat there (`codingTeamView`); Being built's "Open in
  coding team" goes through `hubNav.openCodingTeam`; project items say on hover which is the coding team and which the
  leadership team's group chat.
- **Rules**: `TALK_RULES` (Leads and coding-team chats); the delegate rules list every ask back, split work by area and
  save Ash's decisions at once with ash_remember; every worker's brief carries `<worker_rules>` (its own port
  `PORT=<n>`, never kill another's process, its own checkout) and a second worker in a busy project gets a worktree.
- **Proof**: `tests/browser/coding-team.spec.ts`; `hub:verify-live` check 21 (`coding_team_delegates`); realtest
  `tests/realtest/scenarios/coding-team.json`. The auto-continue effect now claims each restart's resume once
  (`inFlight.ts claimAutoContinue`).

# Update: 20 October 2026, Phase 4 (branch hub/4-pages-newproject)

Pages, Change the hub, Today's board and New project now go through Ash OS (exo-cc-studio `docs/HUB-BACKEND.md`):
- **Pages** (`pages/model/pages.ts`): kept pages are Ash OS's record (`ash-hub-pages` incl. removed, read by the
  hub store and its `pages` feed topic). Keep / Keep and allow / pin / Allow / Bot changes Undo-Redo call
  `ash-hub-page-update` and `ash-hub-page-remove`; a tap shows at once and a refusal puts it back with the reason
  (`pagesProblem`). Pages kept on this Mac before are sent once (copy in `monocode:pages.before-record`). Only the
  example data keeps pages locally. `buildPage` sends `wait: 30` (hub.rs then allows 45 s) and maps "<Mono> is still
  building..." to a still-building card; Try again collects the same build. The in-app runner path is gone.
- **Change the hub / Edit Today** (`hubChange/`): previews send `wait: 30` (still building + Try again); Apply,
  Undo, Redo go through the live store (re-reading changes, layout, projects). History from `ash-hub-changes` under
  the ask box, the last change on Today, and Bot changes (`setHubChangeSource`) all read the same record rows.
- **Today** draws `ash-hub-layout` (`snap.today`): since, setup, needs, being-built (quiet list, hidden when idle),
  and kept pages placed by a change. A project's Inbox keeps its fixed order.
- **Projects** (`model/projectActions.ts`): the strip is Ash OS's list in its order (the hard-coded four are gone).
  Shapes are Ash OS's 14 (`projectShapes.ts`; "ghost" reads as gamepad), grey glyphs on the tile; the tile menu
  (right-click, long-press, the hover dots) picks a shape (`ash-hub-project-rename {icon_shape}`), renames
  (`name`), and Remove from hub archives (`ash-hub-project-archive`, counts first, Undo unarchives). Emoji / image
  stay this Mac's own overrides. Local names are moved to Ash OS once. Move up / down is still local only (the
  studio has no direct reorder call; an applied `strip.order` change clears the local order).
- **New project**: the Chief of Staff questions are still scripted; the preview card shows what Create makes (code
  folder `~/Projects/<id>` / an existing folder / none, own memory, team + "<Project> lead", icon). Create calls
  `ash-hub-project-create`, seeds the Lead (`hubLeads.ensureProjectLeads` now covers every strip project) and
  registers it (`ash-hub-mono-project-add`).
- Stub: `scripts/hub-stub-studio.mjs` (HUB_STUB_BUILD_MS sets build time). The read-only live proxy allows
  `pages`, `layout`, `changes`.

# Update: 16 October 2026, continuation 06 branch

See `docs/CONTINUATION-06.md` for the current change scope and acceptance boundaries. The historical notes below predate this batch. In particular, group chats and Pages now have a normal Mono session runner path, group history/membership persist, custom models support configured reasoning levels, and the test copy has its own identity. Live provider and daily-app acceptance are still separate checks; do not infer those from this handoff.

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
- `hubActivity.ts`: real use only (typing or a click; not scrolling, hovering,
  window focus or reopening the app; ignored while the window is hidden). Reports the time of the latest input to
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
- Projects made with New project are made in Ash OS and join its strip (20 Oct update at the top).

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
A service without `ash-hub-jobs` just means nothing is being built. Watched pull requests (`features/pr-watch`, a
Mono's `pr_watch`) are this app's own rows, not Ash OS's: each live watch is a "Waiting on CI" job under its Mono
(`prWatchJobs.ts`), with the pull request's state on a second line and Stop watching in its story.

**Project Leads (`hubLeads.ts`).** In the Hub bundle (and on the dev page with a
stub or the live proxy), once Ash OS has listed the projects, each gets its Lead
Mono if missing: `vg-game-lead` "EXO lead", `hivra-lead`, `nibbii-lead`,
`ash-lead` "Harness lead". Each is tied to its project's folder (so the Coding
team's Monos rail shows it), gets a soul in Ash's words (orchestrator, his full
words to workers, `sonnet` workers, its memory loads by itself, `ash_dump` verbatim,
verify, Looks right only when critical, its identity), is written to
`<app data>/monos/<id>/SOUL.md` right away, and is registered in Ash OS as the
project's Lead (`ash-hub-mono-project-add`, role lead). Never re-made, renamed or
re-souled. A Lead's chats start in its project's folder (`monoWorkspace.ts`);
other Monos still start at home. Every hub chat's Claude Code session gets one
`--mcp-config` (`model/hubMcp.ts`, through `claudeExtraArgs.ts`; MonoCode
registers nothing there): Ash's own `ash-os` entry (read in Rust,
`hub_ash_os_mcp`, only that entry from `~/.claude.json`) with the chat's identity
(`ASH_CHAT` always; `ASH_MONO_ID` / `ASH_ROLE` lead, mono or checker for a Mono's
chat and its habit runs; `ASH_ROLE=worker` for a chat started through the app
CLI; `ASH_PROJECT` for a Lead's chat, its habit runs and every worker under it,
however deep, so Ash OS lets them reach only that project's memory and `ash`;
none for the leadership team, other Monos and plain chats), and for a Mono's own
chat the delegate tool (`monocode mcp`, Phase 2 H3). A Lead's fresh conversation
(a new or rotated session) and its workers' briefs start with the project's
memory primer (`model/hubMemoryPrimer.ts`, `ash-hub-memory-primer`: its current
never-do rules and decisions and Ash's global ones, bounded), in the prompt, so
an engine with no ash-os tools gets it too.
Checked with Claude Code 2.1.302 on 19 Oct: a `--mcp-config` entry replaces the
user-scope server of the same name, `${VAR}` in its env and args is expanded from
Claude Code's own environment (an unset one stays literal), and a stdio server
inherits that environment too (the 15 Oct note that it sees only HOME, LOGNAME,
PATH, SHELL and USER no longer holds); the identity stays in the entry anyway.

**The checker (Phase 2 H6, `model/hubChecker.ts`, `model/hubChecks.ts`).** One small Mono, "Checker" (`checker`,
Claude Code on Haiku: Haiku 5.5 when the CLI lists it, else its `haiku` alias; `Mono.model`), made by
`app/hooks/useHubChecks.ts` in the Hub bundle's main window with an hourly habit (given once; Ash's remove or pause
sticks): `ash_checker_queue`, one `ash_checker_note` per flagged message, always `NOTHING_TO_REPORT`. It can't start
work, three ways, each tested (`hubChecker.test.ts`): the app lane (`agentApp.ts` `CHECKER_ACTIONS`: models.list,
memory.*, soul.read only, for its chat and its habit runs); its tool list (`hubMcp.ts` `checkerToolArgs`: ash-os as
role `checker`, no delegate tool, `--tools Bash,Read,Grep,Glob`, `--disallowedTools` Agent, Task, Edit, Write,
NotebookEdit, `Bash(ash:*)`, `Bash(claude:*)`, its ash-os tools pre-approved); no delegation (tasks.* refused, its
context is `<checker_rules>`, never the session or delegate rules). Delivery: the store pulls `ash-hub-checks` at boot
and on feed topic `checks` (`onChecks`); `CheckDelivery` hands each to its owner's chat (a Mono's current chat, made
if missing; a hub chat by id; never the checker, a worker or a chat outside the hub) only when that chat is idle with
nothing queued or waiting on Ash, one per chat at a time, as an internal user turn with `monoCheck` and the receipt
`mono-check-<id>` (so a restart only confirms it), then `ash-hub-check-delivered`. The chat shows it as one quiet
collapsed line (`ui/CheckTurnCard.tsx`: "Checker's note · answered: right", the note and the answer behind a click);
no unread count, no notification, never on Today. Owners learn to answer from `<check_rules>` (`checkerRules.ts`, with
the delegate rules): `ash_record check {id, verdict, note}`, then "Right: ..." or "Fixed: ...". A dev copy can opt in
to an ash-os stand-in that only talks to its stub (`VITE_MONOCODE_DEV_ASH_OS`, `scripts/hub-stub-ash-os-mcp.mjs`).

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
npm run dev                                                 # vite on :1420
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
npm run dev
open "http://localhost:1420/hub-dev.html?live=http://127.0.0.1:18869"
node scripts/hub-live-screens.mjs <dir>  # screenshots of Today, Since and each project's Inbox
```
Writes (Seen, job choices) are proven only against the stub: nothing here has
pressed them on Ash's real data.

### Run it against the real service
1. Ash OS must be running a build with the hub calls (branch `ash-os-hub-core`
   landed). Until then the running service answers "Unknown hub action" and the
   app shows the "isn't running" panel.
2. The daily app finds the key itself. A dev copy never gets it (src-tauri/src/hub.rs):
   `npm run hub:dev -- --hub live` starts the read-only proxy in-process on a free port with a throwaway
   token for the dev copy, and `npm run hub:dev` (`--hub stub`) the stub. To aim the plugin at another
   local port or key file yourself: `MONOCODE_HUB_PORT` and `MONOCODE_HUB_TOKEN_FILE`. The host is always
   127.0.0.1.

### Tests
`npm test` (vitest): `model/hubStore.test.ts` (store against the stub over real
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
- **Connectors** are wired (phase 4, below). Ash OS's own `setup` list is still
  shown read-only.
- **Sections, templates, proposals, Changes, Bot changes** (`templates.ts`,
  `proposals.ts`): local mock stores.
- **Setup export/import**: still local (`addMockProject` for restored projects). New project creates through
  Ash OS (see the 20 Oct update at the top).
- **Question and gate Needs buttons** (See options on a question, Open, Start)
  still do nothing: Ash OS has no `need-act`, `gate-done` or question options.
  **Show details** is not rendered (`details` is read into the store, not shown).
- **Unsorted Needs** (`unsorted` in `ash-hub-needs`) are not read or shown.
- **Monos rail by membership** (`ash-hub-mono-projects`) and `ASH_MONO_ID`
  identity: Monos still come from MonoCode's own roster.
- Capture hook, heartbeat for the doctor banner, keep-alive and launch at login.
- Not verified: the plugin inside a running Tauri window (see the report).

## Connectors and teams (phase 4, 19 Oct)
- **One catalog** (`model/connectorCatalog.json`: 28 direct connectors plus Composio) is read by the page and compiled into Rust
  (`src-tauri/src/connectors/`). Direct ones are official or well-known MCP servers: hosted ones (GitHub, Linear,
  Notion, Supabase, Vercel, Stripe, Google's Workspace servers, …) are bridged to stdio by the app's own binary; local
  ones (Slack, Airtable, Brave, …) run as a child; Telegram is built in. Composio is one switch-gated entry.
- **Logins**: Keychain only (`monocode-hub:connector:<id>`, dev copies `monocode-hub-dev:…`). `<data>/connectors.json`
  holds which are signed in, which projects allow each (`*` everywhere, `~` Monos outside a project, else project
  keys), per-Mono choices and the Composio switch, never a secret. Pasted keys go to `connector_save_login` once;
  browser sign-in (`connector_oauth`) is MCP authorization (discovery, dynamic registration, PKCE) or Google with Ash's
  own OAuth client; Ash finishes every sign-in on the provider's page.
- **Sessions**: a Mono's chat and its habit runs get entries pointing at `<app> connector-run <id> --mono <id> --project
  <key>…` inside the chat's one `--mcp-config` (`hubMcp.hubMcpArgs`, beside ash-os and the delegate tool;
  `hubConnectors.connectorServersForMono`). Workers and plain chats get none. The launcher re-checks the rules and reads the Keychain at start. A Mono in two projects only
  gets what both allow; nothing is allowed until Ash ticks a project. (The leadership team now sits in every project, so
  it only gets connectors allowed in all of them or "Every project".) Codex and other engines get no connectors yet.
- **Teams** (`model/hubTeams.ts`, Settings → Teams): a team has a brief, projects, named Monos and a room (a normal
  group chat in its first project). Ash makes Monos there (name, lane → SOUL, engine, projects, connectors); agents
  can only `app monos.propose`, which waits on Today's Setup and Settings → Teams until Ash approves.

## One "waiting on Ash" list
- `model/waiting.ts` is the only list of things waiting on Ash. Each page adds
  its items through a provider there: Inbox (Needs and stuck items), Builds
  (failed builds that are stuck or gave up), Being built (stuck workers not
  already covered, linked by `Worker.waitingId`).
- The strip counts (`waitingCount`), Today, each project's Inbox and every
  "Take a look" button (chats, builds, being built) read only from it. Never
  count separately. A new page must add a provider, not its own count.
- At most 5 Needs per project (`MAX_NEEDS`).
- The strip count also adds the project's chats waiting on Ash (next section).

## Questions live in the chat that owns the work (19 Oct)
- **Waiting on you** (`model/waitingChats.ts`, `ui/WaitingOnYou.tsx`): one row per chat whose agent asked Ash
  something, above Needs you on Today and in each project's Inbox: project, chat (a Mono's name or the chat title),
  the one-line question and the agent's pick. "Take the pick" answers in that chat in one tap, "Open" jumps in, the
  box answers in his words; answered rows tick and stay until he leaves, "Take all N picks" clears every row with a
  pick that is not a red line.
- Two shapes, read by `model/chatQuestions.ts`: a live AskUserQuestion (pick = the option marked "(Recommended)",
  answered in place through `respondHarnessQuestion`), or a finished turn ending "Needs Ash: …" / "My pick: …"
  (answered with a message into the chat). The list is kept in local storage, so a question cut off by a restart still
  waits and is then answered with a message naming it. App wiring: two effects next to `onQuestionReply` in App.tsx
  (`noteChats(sessions)`, `setWaitingChatsHost`).
- **Hooks.** Autopilot: `waitingChats()`, `subscribeWaitingChats`, `autopilotMayTake`, `takePick(id, { by: "autopilot" })`
  (refused on a red line). H4: `setWorkerQuestionRouter` (return true when a worker's question went to its Lead; until
  H4 sets one, every question is Ash's).
- **Older questions** (`ui/OlderQuestions.tsx`): the retired studio queue as one quiet "Older questions (N)" line at
  the bottom of Today, in no badge. Opened: answer any row with its sheet, or "Dismiss all older than 3 days / 1 week /
  2 weeks / 1 month" (`ash-hub-older-dismiss`, Ash only; their asks are parked, never dropped). Ash OS (branch
  `ash-os-questions`) adds no new questions to the queue and keeps only red-line gates and failures as Needs.
- Agents are told how to ask (`model/askAshRules.ts`, in every Mono's context): decide what they can, ask only what
  truly needs Ash, in their own chat, always with a pick; workers ask their Lead.
- Stub: `MONOCODE_HUB_STUB_SCENARIO=questions npm run hub:dev` shows the retired queue (`startStub({ questions: true })`).

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
