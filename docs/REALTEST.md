# Real-Claude end-to-end tests (`npm run hub:realtest`)

Ash, 20 Oct: "i want you to run real tests to make sure that this works on a test project that would really push
things to see where it's lacking and what has to be fixed". This bench runs the Hub with **real Claude** on a demanding
test project, plays Ash's side from a scenario file, and grades what the team does against Ash's own benchmark.

The fake-Claude bench (`npm run hub:verify-live`, `scripts/fake-claude.mjs`) proves the plumbing through restarts. This
one proves behaviour: who answers, how fast, whether agents talk among themselves, whether a stuck worker is visible,
whether memory stays in its project.

## Run it

```bash
npm run hub:realtest                                  # build, run tests/realtest/scenarios/baseline.json, grade
npm run hub:realtest -- --no-build                    # reuse target/debug/monocode
npm run hub:realtest -- --only s01-room-dump,s02-room-wat-now
npm run hub:realtest -- --max-turns 120 --max-minutes 40 --max-requests 800
npm run hub:realtest -- --no-grade                    # rule metrics only, no Sonnet grader
npm run hub:realtest -- --grade-only evidence/realtest/<run>   # grade (again) a finished run
npm run hub:realtest -- --scenarios tests/realtest/scenarios/smoke.json --no-grade   # 3-minute plumbing check
npm run hub:realtest -- --keep                        # keep the temporary HOME (and the Tally repo) afterwards
```

It runs in the background (the dev copy is an accessory app that never takes focus) and needs the dev copies' Claude
login (`~/.monocode-hub-dev/claude-config`, Ash's Max account). Budget matters: see "Budget" below.

## What it never touches

- **Not the daily app.** The copy is a dev slot (`com.ash.monocode-hub.dev.<worktree>-realtest`) under a throwaway
  HOME; its identifier is checked against the kind table before anything starts. It never reads
  `~/Library/Application Support/com.ash.monocode-hub`, `~/Applications` or `~/.claude`.
- **Not Ash's ledger or memory.** Ash OS is the in-process stub (`scripts/hub-stub-server.mjs`) with a throwaway
  token. Memory is the run's own invented folder (below), never `~/agent-memory`.
- **Not Opus, not max effort.** Every Claude chat goes through `scripts/hub-realtest-claude.mjs`, which holds `--model`
  to `sonnet` and `--effort` to `medium` at spawn and on live `set_model` / `apply_flag_settings` (Haiku helper calls,
  such as the room's router, stay Haiku and get no effort added, as the app runs them: an added effort made each one
  think for 5 to 7 s). The window's own defaults are set to Sonnet 5 + medium as well.
- **The temporary HOME's keychain list** is pointed at the login keychain so `claude` can read the dev login (written
  to `<tmp HOME>/Library/Preferences/com.apple.security.plist`; the real one is untouched), and
  `<tmp HOME>/.monocode-hub-dev/claude-config` is a link to the shared dev config, so the app and Claude agree on where
  transcripts live.

## How it drives the app

`src-tauri/src/verify_live.rs` already lets a dev copy under a temporary HOME read a verify plan. The plan now has a
`driver` folder. The run drops one JSON action per file into `<driver>/inbox/`; the window takes them with the
`verify_live_take` command, does each, and answers with `verify_live_done` into `<driver>/done/`. Both commands refuse
unless this process has a plan with a driver, so the daily app can never use them. The window side is
`src/app/model/verifyDriver.ts`, wired in `App.tsx` next to the Stop button's handler. Actions use exactly what Ash's
typing and clicks use:

| Action | What it calls |
| --- | --- |
| `send` to a room | GroupChatView's composer path: `sendMessage` / `startConversation` then `simulateReplies` |
| `send` to a Mono | `onOpenMono` (the rail click) then the composer's `onSubmit` (queues or steers when busy) |
| `send` to a worker | the rail's `openChild` (owner's Mono, then the sub-chat), then `onSubmit` |
| `stop` | the Stop button (`delegationTree.stopFromUser`) |
| `answer` | Today's Waiting on you row: "Take the pick" (`takePick`) or "answer in your words" + Send (`answerInWords`) |
| `open` a hub view | close the Mono view, then `setHubSelection` (Today, Being built, the room); returns the visible text |
| `snapshot` | sessions (busy, model, effort, queue, rail state), Monos, rooms with every message, hub localStorage, every `data-hub-*` / `data-mono-*` element |
| `drain` | the timestamped log: room messages as they land, typing, every chat's busy/question/queue changes, console errors |

Screenshots: `screencapture -x -o -l <window id>` of the copy's window (found with a tiny Swift CGWindowList script).
If capture fails (screen locked, window off-Space) the view's text is still kept and the run says why.

## The test project: Tally (`tests/realtest/tally`)

A small TypeScript monorepo with zero dependencies to install (Node 22 strips the types): `packages/shared` (types,
input checks), `packages/api` (`node:http`: list, create, bump, stats; JSON file store), `packages/ui` (React board
and its pure helpers). It is copied fresh into a temporary folder and committed as a new git repo each run.

It has what makes delegation, review and stuck cases happen naturally:
- **a failing test on purpose** (`median` of an even count), so "fix the tests" is real work with proof;
- **a deliberately ambiguous requirement** in the README (the weekly reset and "last week's total");
- **a decision only Ash can make** (sharing: public or private), marked "do not build until he picks";
- **drift between packages** (the UI's own copy of the tally type) and a backlog (`TODO.md`).

The stub lists it as project `tally` with its folder, so the hub makes **Tally lead** and seats the leadership team
(Chief of Staff, Projects Manager, frank, Alfred) in `tally:leadership`. The stub's invented Needs are cleared so Today
is about this run.

## Stand-ins for what the real Ash OS does and the stub doesn't

Both are labelled in the evidence, so nobody mistakes them for the service:
- **Memory** (`scripts/hub-realtest-memory-mcp.mjs`): a dev copy's chats have no `ash-os` server (harness.rs keeps
  only the delegate tool) and the stub has no memory, so the Claude wrapper adds an `ash-os` server with `ash_recall`
  (that project plus the global layer, the real rule) and `ash_remember`, over the run's own folder. Seeded from the
  scenario file: Tally facts, an EXO fact that must never show up in Tally, and global "how Ash works" rules. Every
  call is logged (`claude/memory-calls.ndjson`).
- **Being built jobs from delegations**: the real Ash OS turns the app's mirrored delegations into Being built jobs
  (`exo-cc-studio ashos/job_sources.py delegation_observations`); the stub only stores them. The run maps the stub's
  mirrored rows into jobs the same way (one per top-level delegation, under its owner Mono; question = stuck "Waiting on
  an answer to a question"; failed = stuck "failed: <class>"). Without it, Being built is always empty in a dev copy.

## Outages on demand

`claude/fault.json` (written by a scenario's `fault` step) makes the wrapper answer the next prompt with the CLI's own
recorded output instead of calling the model (`src/integrations/harness/providers/claude/fixtures/claude-cli-2.1.302`):
`529` (overloaded: the model is down), `402` (out of credit), `429` (rate limit). `scope: "new"` hits only chats started
after the fault was set (a new worker), `times` caps how many prompts it eats.

## Scenarios (`tests/realtest/scenarios/baseline.json`)

Each scenario has its own minutes and turn cap; every wait is bounded. Benchmark ids are in `tests/realtest/benchmark.json`
(B = the Grok leadership room, 15 Oct; P = the past-requests benchmark; DB = deal-breaker).

| Id | What Ash does | Checks | Max min / turns |
| --- | --- | --- | --- |
| s01-room-dump | a long no-tag voice dump into the leadership room | B1, P5, NOT | 6 / 20 |
| s02-room-wat-now | "wat now" | B6, P5 | 3 / 10 |
| s03-room-plan-to-lead | "ok go ... get it reviewed in here": CoS briefs the Lead, the report comes back for review | B2, P7, B8, B10 | 12 / 70 |
| s04-room-interrupt | "hold on. make it work fully ..." mid-round | B3 | 8 / 40 |
| s05-room-skip-review | "skip review just ship it: GET /health ..." | B4, B8 | 10 / 50 |
| s06-worker-stuck | Lead: "have a worker add sharing" (Ash's open decision); Ash answers in the sub-chat | B12, P3, P4, B13 | 12 / 50 |
| s07-room-pushback | a proposal against the decision just made, then Ash pushes back | B7, P6, B10 | 9 / 30 |
| s08-outage | the Lead hits a 529; a new worker hits a 402 | B9, P15 | 10 / 30 |
| s09-where-are-we | "where are we / wat do u need fro me" | P14, B6 | 3 / 10 |
| s10-from-now-on | "from now on always run npm test ..." | P9 | 3 / 10 |
| s11-memory | the Lead and the room recall Tally's colour and the sharing decision | B14, P8 | 6 / 20 |
| s12-page | "make me a dashboard page of what the agents are doing ..." | B15, P10 | 6 / 25 |
| s13-lead-dump | a 40-ask dump into the Lead's chat | P1, NOT | 6 / 60 |
| s14-lead-busy | a question to the Lead while its workers run | B11, P2 | 4 / 15 |
| s15-lead-parallel | "look into X in parallel, keep chatting" | B5, B11 | 10 / 50 |
| s99-run-wide | rule checks over the whole run | B14, NOT, P17, B8 | 1 / 0 |

Not covered, on purpose: P11 (changing Today: the stub's "Change the hub" is invented, so it would prove nothing), P12
(a hub bug fixed and shipped from a Lead: it needs the hub repo as the test project and a ship drill, far past this
budget), P13/P16/P18 (skipped by the brief). B8 and B10 are graded where they happen to arise.

### The coding team (`tests/realtest/scenarios/coding-team.json`)

`npm run hub:realtest -- --scenarios tests/realtest/scenarios/coding-team.json` starts chats in Tally's coding team the
way Ash's New session there does (`send: {codingTeam: "project"}`, named with `as`, written to again with
`{chat: name}`, waited on with `chatReply` / `chatText` and `delegation.ownerChat`). c01: a bug and a question while it
works; c02: six asks and a rule (listed back, split by area, the rule saved; `metrics.workers` gives each worker's port
and checkout); c03: a decision saved in a coding-team chat, recalled by the Lead. Bounded at 90 turns and 40 minutes.

## Budget

The login is **Ash's own Max account, shared with his own work and every other agent**. Before anything starts, one
tiny Haiku call reads the account's use from the CLI's `rate_limit_event` (`account-before.json`); the run refuses to
start when the 5-hour window is above 60% (`budget.startBelowFiveHour`) or the account is already limited.

Defaults (scenario file `budget`, overridable with flags): **350 model turns** (a turn = one prompt into a real chat),
**2,500 model requests** (each assistant message), **115 minutes**, and the account guard: stop when the 5-hour window
passes **85%** (`stopAtFiveHour`) or the 7-day passes **70%** (`stopAtSevenDay`), or the moment a chat is refused
("You've hit your session limit", a `rejected` rate_limit_event). The run checks every 1.5 s; when any cap is hit it
writes `claude/stop`, the wrapper refuses every new turn ("Realtest budget spent"), and the remaining scenarios are
skipped with the reason. Helper calls (the room's Haiku router, chat titles) are counted separately. The grader is one
Sonnet medium call per scenario. Rough cost of the baseline: about 40 model turns and 200-400 model requests per
hour of scenarios, most of it the Lead's workers; a 40-ask dump or a "do it all" in the room makes the most.

Scenarios that talk to the Lead after s06 set `takePendingPick`: when the Lead is waiting on a question for Ash, he
taps "Take the pick" on Today before writing (recorded in the timeline). Without it, one unanswered question blocks
every later message to that Lead (see the baseline findings).

## Evidence (`evidence/realtest/<run>/`, git-ignored)

- `run.log`, `summary.json` (build, wall time, usage), `results.json`
- `events.ndjson` (the window's timestamped log), `jobs.ndjson` (Being built jobs made from delegations)
- `snapshot-ready.json`, `snapshot-final.json`, per-scenario `scenarios/<id>/snapshot-*.json`
- `scenarios/<id>/evidence.json` (sends, every room message and Claude reply with times, delegation rows, views,
  metrics), `transcript.md` (what a person and the grader read), `grade.json`
- `claude/claude/<pid>.ndjson` (every Claude process: args as the app gave them and as run, prompts, every stdout line),
  `claude/usage.ndjson`, `claude/memory-calls.ndjson`, `claude/fault-hits.ndjson`
- `screens/*.png` when capture works; `db/monocode.db` (the copy's database after the run); `monos/<id>/` (each Mono's
  MEMORY.md and SOUL.md); `memory-before/`, `memory-after/`; `project-git-log.txt` (what the agents committed)
- `grades.json`, `report.md`

## Grading

Rule metrics come from the player, not a model: time to first reply per message (room: first non-Ash message; chat:
first assistant text in that chat's Claude stream), for the room also the first words Ash could read (a live message
as the turn writes it, the driver's `room-draft` event) and every post's length, who answered, replies per Ash message, delegations by owner and
state, workers seen in the room, em dashes in what agents wrote to Ash, another project's facts anywhere, duplicate room
messages, console errors, memory calls. Then `scripts/hub-realtest-grade.mjs` sends each scenario's transcript and
metrics with its benchmark items to Sonnet (medium, no tools, no MCP), which answers PASS / PARTIAL / FAIL /
NOT-TRIGGERED per item with the evidence quoted. `report.md` puts the grades, timings and problems together.

## Baseline, 20 Oct (hub/next 9d9e6351 plus this bench)

Four runs, because the shared account hit its limit mid-run and one unanswered question blocked the Lead: s01-s05
`evidence/realtest/20261020-152110-ab58`, s06-s08 `20261020-165951-879b`, s08-s15 + s99 `20261020-172441-21fa`,
s13-s15 again `20261020-174916-15c6`. Each folder's `report.md` has the grades with the evidence quoted.

| | Result | What was seen |
| --- | --- | --- |
| Room first reply | FAIL | 27-58 s for the host (median about 36 s; Grok 9 s). Router pick median 19 s, 8 s of it a dead wait |
| Room dump / wat now | FAIL | One good CoS digest, but slow; walls of text (median room message 1,255 chars); "wat now" drew 3 messages once |
| Plan to Lead to report | PARTIAL | CoS briefed the Lead, 3 workers, report with commit and 45/45 tests back in the room; review never closed |
| Interrupt / skip review | FAIL / PARTIAL | Ack 51 s; skip-review shipped with a commit and a live call, no test output |
| Worker stuck (Lead asked Ash) | FAIL | Question shown well on Today (Take the pick); Ash's typed answer queued behind it; Lead blocked 20+ min |
| Pushback | PARTIAL | frank and Alfred pushed back with reasons; CoS locked first and corrected after |
| Outage / out of credit | FAIL | Raw CLI error in the chat only; rail back to idle; nothing on Being built or Today |
| where are we / from now on | PARTIAL / PASS | One question with a pick; the rule saved to memory at once |
| Memory | PARTIAL | Lead used Tally memory; Ash's decision never saved, so the room could not recall it; no EXO leak in any run |
| Page | FAIL | None possible; CoS said so plainly |
| 40-ask dump / busy / parallel | PARTIAL | Ack 15 s, one worker for 36 items, no item list; Lead answered in 16 s while working; look-into came back in 90 s |

## Lessons from the first runs (20 Oct)

- **Never edit files in this worktree while a run is going.** vite and Tailwind watch it: saving
  `docs/REALTEST.md` at 17:26:36 reloaded the dev copy's window one second after Ash's message, which cut the Lead's
  turn ("Turn interrupted when MonoCode quit.") and it was never resumed. Edit in another worktree, or wait.
- **The account is shared.** The first full run hit the 5-hour limit at 15:43 UTC (it started at 90% because of Ash's
  and other agents' work); everything after ran against "You've hit your session limit". The guard above now stops the
  run instead, and that stretch is kept as real out-of-budget evidence (`scenarios-after-limit/`).
- **One unanswered AskUserQuestion blocks a Lead.** Every later message queues behind it, so scenarios after s06 tap
  "Take the pick" first (`takePendingPick`) or they test nothing.
- **`fault.scope: "new"` can hit the Lead**, not only a new worker: the app restarts a chat's CLI after an API error,
  so the next process may be the Lead's own. A worker-only scope is still to do.
- **Where Ash really talks.** The baseline sent Ash's task messages to the Tally lead's own chat (the Monos rail). Ash
  (20 Oct): the project's **Coding team** (its Sessions list) is the main place for tasks; the leadership team is the
  group chat. The next run drives the Coding team (a `codingTeam` target for `send`, added against the merged build).

## Files

| File | What |
| --- | --- |
| `scripts/hub-realtest.mjs` | the run: HOME, project, wrapper, build, vite, stub, app, driver client, scenarios, evidence |
| `scripts/hub-realtest-scenarios.mjs` | the scenario player and transcript writer |
| `scripts/hub-realtest-claude.mjs` | the `claude` wrapper (login, Sonnet + medium, logs, budget stop, outages, memory server) |
| `scripts/hub-realtest-memory-mcp.mjs` | the memory stand-in |
| `scripts/hub-realtest-grade.mjs` | the grader and report |
| `src/app/model/verifyDriver.ts` | the window's side of the driver |
| `src-tauri/src/verify_live.rs` | `driver` in the plan; `verify_live_take` / `verify_live_done` |
| `tests/realtest/tally/` | the test project |
| `tests/realtest/scenarios/*.json` | scenario files (`baseline.json`, `smoke.json`) |
| `tests/realtest/benchmark.json` | the benchmark items the grader uses |
