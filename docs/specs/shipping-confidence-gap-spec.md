# Shipping confidence: what Dropwave enforces today, what it only asks for, and what to change

Status: spec only. Nothing here is built by this document and no app code changed with it.
Written 13 Nov 2026 against `main` at `21b08eee`. File and line references are from that commit.

Ash's goal: near-certainty that whatever a Mono's crew sets out to do gets done well and gets tested, and that bugs
can't escape because the pipeline makes escape hard by construction. Taste and design quality are out of scope.

How this was made. Every claim about this repo was read from the code and carries a file and line. All 73 sources in
Ash's research list were opened themselves: each repo was cloned and its implementing files read, and each article
was fetched and read in full (nothing was run or installed). Where a source turned out to say something different
from its one-line summary, section 8 says so. The reading was done by cheaper workers and the key code citations were
checked again by hand.

Two pipelines are in play and the spec keeps them apart:

- **The repo pipeline**: how Dropwave itself is built (CI, `npm run check`, `hub:check-all`, `hub:ship`).
- **The crew pipeline**: what the app gives any Mono's crew on any project (briefs, gates, the delivery path).

Fast iteration mode is on today (no tests, no per-PR review until Ash cuts a release). Nothing here asks to end that
early. Section 9 says what to run at the release pass and what to switch on after it.

## 1. The short version

Dropwave's strongest piece is already built: when a delegated worker says "done", code runs checks on the worker's
own copy and a check that could not run never counts as a pass. The gaps are around it. That gate is easy to walk
past, the checker cannot run anything, nothing proves the tests are any good, and the real app is not exercised before
a ship. All twelve of this month's known escapes fit one of those four holes (section 6).

| Layer | Repo pipeline | Crew pipeline |
| --- | --- | --- |
| a. Acceptance contract before code | Prompt-only | Partial: a brief must be non-empty, not runnable |
| b. Test first, enforced | Missing | Missing (a skill name in the brief) |
| c. No done without proof | Partial | Partial: strong gate, but off unless the first mate asks |
| d. Blind checker, other model, re-runs, round cap | Missing in fast mode | Partial: reads the diff only, always Haiku, one fix round |
| e. Mutation testing on the change | Missing | Missing |
| f. Escaped bug becomes a test and a rule | Habit only | Prompt-only |
| g. Real-app check | Partial: exists, run by hand | Partial: optional button and optional plugin |
| h. Merge queue, flaky quarantine | Missing | Partial: holds only when files overlap |
| i. Property tests on core logic | Missing | Missing |
| j. Measured escape rate | Missing | Missing |
| Test files watched | Not in CI | Partial: counts lines, so a swapped assertion passes |
| Workers see only failing output | n/a | Prompt-only |

## 2. What is enforced in code today

These hold whatever a model says. They are the base to build on.

**Briefs and contracts**
- A brief with an empty or placeholder intent, spec or goal is refused before anything starts
  (`src/features/firstmate/model/brief.ts:86-110`).
- A multi-part plan is refused when a part needs something no part provides, two parts own one path, or a path is
  outside the project (`src/features/firstmate/model/fanoutContract.ts`, header and `:408-413`). A part that needs
  another waits until the provider is done, its checks passed and what it provided is on disk
  (`src/features/firstmate/model/fanoutWaves.ts:41`).

**When a worker says done**
- A report with no self-review is refused twice over: by the app and by the store
  (`src/features/monos/model/workerReview.ts:50-100`, `src-tauri/src/delegations.rs:915-918`).
- Gates run on the worker's own copy: something changed, the project's checks pass, nothing is left uncommitted, and
  (if asked) the test count did not drop (`src-tauri/src/firstmate/gates.rs:1-36`, `:915`, `:943`, `:1010`, `:1064`).
- A gate that could not run is never a pass (`gates.rs:164`, `:183-195`; `src-tauri/src/verify_stage.rs:1-12`).
- Code compares the report with the diff before any model reads anything: a false "only touched" claim, files outside
  the stated scope, a test file with fewer assert lines or a new skip, debug leftovers, and a push or post nobody
  asked for (`src-tauri/src/firstmate/done_check.rs:1-20`, `:561-590`). Any one of these fails the round and the
  model cannot overrule it (`gates.rs:438-440`).
- Fact gaps from the worker's own transcript fail the round: a failed check, a check that went stale after a later
  edit, a "passed" claim with no run after the last edit, an open to-do, an edited package no test reached
  (`src-tauri/src/firstmate/fact_gaps.rs:1-9`, `:1258-1271`).
- Accepting an "unsure" result is void if the files changed since the check (`gates.rs:2043-2055`).

**Delivery and merge**
- One merge path. It refuses red or pending checks, a draft, a conflict, an open decision, and it merges only the
  head it judged (`src-tauri/src/delivery/merge.rs:1-25`).
- It holds a pull request when main changed files that pull request touches (`src-tauri/src/pr_watch/base.rs:424-428`).
- A pull request on a security path needs a recorded review whose reviewer is not the author and whose verifiers
  are neither (`src-tauri/src/delivery/review.rs:166-168`, `:255-262`; `merge.rs:283-288`).
- Secrets and agent-only files are kept out of commits and pushes (`src-tauri/src/commit_guard.rs:1-13`).
- A first mate cannot edit the project: read-only launch where the CLI allows, and an after-turn check everywhere
  (`src/features/firstmate/README.md`, `src-tauri/src/firstmate/checkout_guard.rs`).

**Shipping Dropwave itself**
- `hub:ship` refuses without a pass record for that exact commit, a matching signature and a database health check,
  then runs the new build on trial and rolls back by itself (AGENTS.md "Ship"; `scripts/hub-check-all.mjs:35-57`).
  This net caught both of this month's broken ships.

## 3. What is only asked for in a prompt

A model can skip every one of these and nothing notices.

- Test first. The brief names pstack's `tdd` skill and says "read it and follow it"
  (`src/features/firstmate/model/briefSkills.ts:7-12`, `:50-53`). pstack itself has no hooks: all its skills are
  text, invoked by name.
- "Never weaken a test", "test what your change can reach", "never paste test output", "leave code you didn't write
  alone" (`src/features/agent-app/model/agentAppTasks.ts:552`).
- "Pass `code: true` on a brief that changes code" (`src/features/firstmate/contract.md:66`).
- "Every task has a completion condition a check can prove" (`contract.md`, Intake).
- Fix root causes, turn lessons into checks (`briefSkills.ts:20-23`; WP-117's `taste-to-checks` skill is installed
  and called by name only).
- "Do not skip or weaken a test without a line in FLAKY-TESTS.md" (`docs/hivra/work/FLAKY-TESTS.md`).
- "Record the failure before changing it" (AGENTS.md, "Improvement loop").
- The first mate's own "done" to the person. Nothing gates it.

## 4. The holes, layer by layer

Each gap gives: what fails today, the smallest change that closes it, where it lives, a rough cost per pull request,
and how to prove the change works. Costs are estimates, not measurements.

### a. Agree what done means before any code

**Today.** The goal is any non-empty text (`brief.ts:86-95`). No step has to end in a command. A brief is not
stamped with the commit it was written against: the gates work out a base at check time (`gates.rs:673-687`). The
plan review that exists (fresh-eyes) is off unless a project turns it on, reads only the plan and up to 8 files, and
critiques rather than agrees a contract (`src/features/fresh-eyes/model/setting.ts:22`, `review.ts:57-72`).

**What fails.** 30 Oct, commit `be83b40d`: a worker whose brief said "do not add the health route" found a sibling's
finished route in its copy, removed it, and its landing took the sibling's test out of the project. The fix was one
more sentence in the worker rules.

**Smallest change.** Add a fourth brief part, `checks`, next to intent, spec and goal: a short list where every line
is `what must be true | command | what the command prints or exits with`. Refuse a code brief with none. Add an
"in scope" and "do not touch" file list. Stamp the brief with the commit and, before work starts, run
`git diff --stat <stamp>..HEAD -- <in-scope paths>`: a change means stop and re-plan. The shape is copied from
shadcn/improve's `references/plan-template.md` (MIT), which has exactly these parts: "Planned at: commit", a drift
check to run first, steps ending in `Verify: <command> → <expected>`, and a list of stop conditions. The lines are
kept as a small JSON file where only the app may flip an item to passed (Anthropic's long-running-agents article
uses the same file but lets the agent flip it, which is an honour system). The person's own words go in a block the
worker and the first mate may not edit (BMAD's "frozen after approval").

Keep it small. A one-line bug gets one check. Böckeler's review of spec tools found big spec files worse to review
than code, and the HumanLayer essay puts the human's attention on a plan of about 200 lines, not on the diff.

**Where.** Captain and first mate: `brief.ts`, the `delegate_task` schema in `src-tauri/src/mcp_server.rs`, and the
checks gate, which then runs the brief's own lines as well as the project's.
**Cost per PR.** A few hundred tokens of brief, plus seconds to minutes for the commands, which mostly run anyway.
**Proof.** The fake-Claude bench: a brief with no runnable check is refused; a planted drift stops the worker; replay
the `be83b40d` case and see the scope list catch the removed route.

### b. A failing test before the code

**Today.** Missing. The app writes no hooks for a worker; a Claude worker runs only the person's own hooks
(`src/integrations/harness/providers/claude/claude.ts:3295-3297`). The test-count gate is opt-in and counts tests,
not "red then green" (`gates.rs:124-141`, `:1010`).

**What the sources really do.** This is where the research list was most optimistic:
- TDD Guard decides with a model call on every edit, keeps one state file per project (not per agent), and Bash
  writes go round it. Its author has moved on to Probity.
- The windyroad plugin decides by rules, but only for JS, only `npm test`, and it counts a broken build as red.
- claude-code-tdd-workflow only checks that some test file appears in `git diff`.
- All three are Claude Code hooks. Codex, Grok, Pi and the rest have no equivalent, and Dropwave runs them all.
- Alonso's article has the one rule worth copying exactly: red means the test summary line shows more than zero
  tests and more than zero failures; green means more than zero tests and zero failures; anything else (a compile
  error, no summary line, zero tests) is inconclusive. Never trust the exit code. Keep state per agent.

**Smallest change.** Do not make an edit-blocking hook the main defence. Check the order after the fact, in code,
for every CLI: the app already reads each worker's test runs and edits from its transcript (`fact_gaps.rs`). Add one
fact gap for a bug-fix brief: "no failing run of the new test was seen before the fix". Use Alonso's summary-line
rule to decide red, green or inconclusive, with a parser per runner (vitest, nextest, pytest, go). As an early nudge
for Claude workers only, pass a `PreToolUse` hook through `--settings` that denies an edit to a non-test file while
no red has been seen. Two things need a ten-minute test first, because the hooks documentation implies but does not
show them: that `--settings` accepts hook definitions, and that a hook still blocks in bypass mode.

**Where.** Worker gate (`fact_gaps.rs`), optional worker hook (the Claude adapter).
**Cost per PR.** None in tokens; the worker runs its test once more.
**Proof.** Bench case: a fix with no red run fails the round; a red caused by a compile error counts as inconclusive.

### c. No done without proof

**Today.** Strong when on, and too easy to leave off.
1. A brief sent without `code: true`, gates or checks stores no plan (`gates.rs:1805-1811`), so no gate and no
   checker run. If the transcript shows no gap the row settles as done: "completed, no gates" reads as done
   (`src-tauri/src/firstmate/status.rs:14`). The flag is the first mate's to remember.
2. With no imported project file or no declared checks, the checks gate cannot run, the result is unsure, and the
   first mate may accept it with no reason at all (`gates.rs:1499-1505`, `:2043-2063`).
3. The real-app recipe (`verify.realPath`) is a button on a card. No gate calls it
   (`src/features/hub/ui/CheckTurnCard.tsx:60-64`).
4. Nothing stops a first mate telling the person "done" while its workers are still out, and nothing checks for an
   unanswered message before done. firstmate itself has a real stop guard (`bin/fm-turnend-guard.sh`, a Stop hook);
   Dropwave ported the contract text but not that guard.

**What fails.** 30 Oct, commit `33fb31b1`: the routes check "was refused and never ran" and the work went through.
12 Nov, PR #303: the script tests had never run in CI at all; the step found zero tests and stayed green.

**Smallest change.**
1. Decide gates from the diff, not from a flag: any worker whose copy changed a tracked non-doc file gets `diff`,
   `checks`, `committed` and the test-count gate, whatever the brief said.
2. "Ran zero tests" is "could not run", in the gates and in CI.
3. Accepting an unsure result needs a reason, is logged, and is shown to the person. A project can set a cap (for
   example, two accepts in a row and the third goes to the person).
4. For a diff that matches the project's `appliesTo` paths, the real-app recipe runs as a gate.
5. The proof is what the app captured (command and exact output), never what the report quotes. Add the section
   Augment's verifier always writes: "what I exercised, what I did not".
6. A first mate's "done" to the person is held while any task under it is open or failed, or any worker message is
   unanswered (the MAMUBench predicate; the app owns the process, so this is a flag, not a hook).

**Where.** First mate gate (`gates.rs`, `status.rs`), CI (`ci.yml`).
**Cost per PR.** The project's affected tests once, which a careful worker runs anyway.
**Proof.** Bench cases: a "docs" brief that edits code still gets gates; a check step that runs zero tests is not a
pass; an accept with no reason is refused.

### d. A blind checker on a different model that re-runs the proof

**Today.** The checker is one Claude turn with no tools in an empty folder, always Haiku unless an environment
variable says otherwise (`gates.rs:1680-1702`, `:1962-1965`). It is blind in the good sense (it gets the claims, not
the worker's story) but its rules say "you can run nothing" and it sees at most 12,000 characters of diff
(`gates.rs:1144-1147`, `:56`). Nothing requires it to differ from the worker's model. It is skipped when a gate
could not run (`gates.rs:436`). The stricter cross-builder review exists only for security paths. The no-mistakes
delivery mode is off by default per project and reviews with the worker's own engine first
(`src-tauri/src/delivery_gate/mod.rs:72`, `:327-333`). Fix rounds are capped at one for gates
(`src/features/monos/model/workerGate.ts:33`) and one for red CI (`src-tauri/src/delivery/events.rs:201-202`);
nothing looks at whether the same kind of finding keeps coming back. WP-197a (a reviewer that runs the changed app)
and WP-197b (review every pull request) are specs with no code.

**What fails.** PR #208 (sandbox) needed seven review rounds after green tests; round 6 alone produced nine failing
repro tests (`ea88224a`). PR #311: a review found that any failure to open the lock read as "a runner is live". No
test had noticed.

**What the sources really do.** fable-judge is a 38-line prompt, and "5 of 5 on Haiku" is two runs on one fixture
its author wrote; treat it as a checklist, not as evidence. pstack's `interrogate` has the rule worth taking: a
finding survives only if a second party re-runs the command that shows it. no-mistakes sets the reviewer globally so
a repo cannot weaken its own reviewer, and when its fix rounds run out the gate parks for a person and never
approves itself. wp-orchestration's "three rounds" is prose; its code re-evaluates after two failed rounds with a
stronger model that either rewrites the brief around a stated rule or hands the work up, and it keeps a ledger where
a worker may dismiss a finding only on one of five named grounds. Anthropic's own evaluator write-up warns that
Claude as a checker "talks itself into" approving until its prompt is tuned against examples.

**Smallest change.**
1. Give the checker a read-only copy of the worker's checkout and let it run only the brief's check commands plus
   one check of its own choosing. No write tools, sandboxed as today.
2. Pick the checker from a different model family than the worker (worker on Grok: checker on Claude, and the other
   way round). The rule lives in app settings, never in the project.
3. Scale by risk. Docs and tiny diffs keep today's cheap read-only check. Code gets the checker that runs. A diff on
   a protected or security path also gets the cross-builder review that already exists.
4. Round cap: after two failed rounds, stop sending raw findings back. One stronger-model step rewrites the brief
   with the rule the work keeps breaking, or sends it to the first mate. After the next failure it goes to the
   person. A worker's dismissal of a finding needs one of a fixed list of grounds.

**Where.** First mate gate (`gates.rs`, `done_check.rs`, `completionGates.ts`).
**Cost per PR.** One extra model run with tools on code tasks: roughly 10 cents to a dollar, and 2 to 5 minutes.
**Proof.** The planted-fraud fixture already in the repo (`src-tauri/src/firstmate/fixtures/fable-s7`) plus five
more built from this repo's own review-repro tests: count how many the read-only checker catches against the one
that runs. Section 4j makes this a standing number.

### e. Prove the tests would catch a bug

**Today.** Missing in both pipelines. There are good hand-run controls (`hub:verify-live -- --fail-gate`,
`hub-harsh`, `hub-bench --check`) but none plants bugs in the lines a change touched.

**What fails.** The repo holds about 200 test files that began life as a review finding. Each one is a bug the
existing tests missed and a reviewer caught. PR #303 removed 37 test files that only matched source text and "pass
when the feature is broken".

**What the sources really do.**
- cargo-mutants is ready for this: `cargo mutants --in-diff pr.diff --test-tool nextest --in-place --baseline skip
  --timeout 300`. Exit 2 means a planted bug survived, 3 means a timeout. It works at function level (one changed
  line tests the whole function's mutants). The list of survivors is `mutants.out/missed.txt`.
- StrykerJS has no git or diff option. It takes line ranges (`--mutate "src/a.ts:10-20"`), so
  `scripts/affected-tests.mjs` has to turn diff hunks into ranges. Its vitest runner is untested against a suite
  this size with jsdom: try it on two or three modules before promising anything.
- Meta's "74 bugs" is narrower than the summary: 74 serious privacy incidents in the first half of 2026 where the
  tool "played a key role", with engineers rating 60% of its findings real. Four in ten were false alarms.

**Smallest change.** Rust first. Run cargo-mutants on the diff for changes under the paths where a miss is costly
(the sandbox, the commit guard, delivery and merge, the gates themselves, ship). Start as a report on the pull
request, not a block: equivalent mutants cause false alarms, and Ash's rule is that noise never blocks. Turn it into
a block for those paths once two weeks of reports show the alarm rate. TypeScript follows after the Stryker trial.
For crews, offer it as a named gate (`mutation`) a project can add where the tool is installed.

**Where.** CI for this repo; an optional worker gate for crews.
**Cost per PR.** Nothing for most pull requests. Roughly 5 to 20 minutes of machine time when a risky Rust path is
touched (to be measured in the trial).
**Proof.** Run it once over the diff since 0.16.17 at the release pass and count survivors on the risky paths.

### f. Every escaped bug becomes a test, then a rule

**Today.** A strong habit and no enforcement. Nothing checks that a fix adds a test. The repo has no linter at all
outside `mobile/` (no ESLint, ast-grep, Semgrep or Danger). A handful of tests scan the source for a banned shape
(`scripts/agent-rules.test.mjs`, `src/features/hub/model/hubWebviewGuard.test.ts`,
`src/shared/ui/focusVisibleHas.test.ts`), which is the right idea done by hand.

**What fails.** PR #304: a hung git process sat on the Mac for two days because a spawn was not in its own process
group. The fix added a test for that one spawn. The same shape can come back at any other spawn.

**Smallest change.**
1. A small script in `npm run check` (no outside service needed): a pull request whose title or commits say "fix"
   must change a test file; a deleted test file or a new `.skip`, `.only` or `#[ignore]` needs a line in
   `FLAKY-TESTS.md`. Danger JS does this too; a 40-line script avoids the dependency.
2. ast-grep (MIT, supports TypeScript, TSX and Rust) with a `rules/` folder. One rule per bug that has a shape, each
   with a "valid" and an "invalid" snippet that `ast-grep test` checks. Error messages say what to do instead, as the
   Factory and OpenAI write-ups both stress. First three rules, from this month's escapes: every spawned process
   gets its own group; no fixed sleep in a test; no releasing an object that Cocoa handed back autoreleased.
3. For crews: when a task is a bug fix, the brief's first check is the failing test, and the gate checks the fix
   came with one.

**Where.** CI and learning loop.
**Cost per PR.** Seconds.
**Proof.** Each rule's own tests; then replay the fix commits of #304 and #306 without their fix and see the rule
fire.

### g. Check the real app, not just unit tests

**Today.** The pieces exist and are run by hand. The 173 browser specs run only on a manual full run
(`.github/workflows/ci.yml:74-79`) and against vite pages, not the app window. `hub:verify-live` is declared as this
repo's real-app recipe (`.monocode/project.json:66-70`) but `hub:check-all` runs only `npm run check`
(`scripts/hub-check-all.mjs:35`), and `hub:ship` does not ask whether the browser run or verify-live happened. For
crews, the e2e plugin is optional and its evidence is only displayed (`src/features/firstmate/model/e2eEvidence.ts`).

**What fails.** This is the most expensive hole this month.
- 12 Nov, PR #306: 0.16.17 crashed two seconds after launch on the real Mac. Every test was green. Only the daily
  app registers the dictation helper, "so dev copies and verify-live never ran it".
- 12 Nov, PR #310: the next ship rolled back because a ship started from Terminal is never signed and the new build
  refuses an unsigned record. No test took the Terminal path.
- PR #334: a provider began sending an array where a string was expected; every chat on that model failed and the
  app reported "out of credit".
- FLAKY-TESTS.md: a ship test's stand-in waited 60 seconds for a lock the real app waits 2 seconds for, so the test
  "would pass a build the real app refuses".
- Outside evidence agrees: Augment's verifier write-up describes a fix where every test and CI check passed and the
  change was wired to an endpoint the real client never calls.

**What the sources really do.** e2e (the repo is now `e2e-inc/e2e`) records a step only after a later deterministic
check passes, and `--strict-cache` fails a stale recording with no model call. That is the mode for a gate. It
drives web and mobile only: it can walk Dropwave's vite pages, not the Tauri window. Its `agent.assert` steps always
call a model, so "replays for free" is true only for tests that end in plain assertions. Playwright's healer agent
has write tools and is told to fix "assertions and expected values"; its only brake is a sentence in its prompt, so
it must not run unguarded. Motion Debugger is plain code with an exit code (no model), tuned to landing pages.

**Smallest change.**
1. Before a ship, `hub:check-all` also requires a recorded verify-live pass and a launch check: start the built
   bundle under a temporary HOME, wait for its window and database, see it stay up for 30 seconds, quit it.
2. Close the "only the daily app runs this" blind spot: each code path that only the daily app takes gets a seam so
   a dev copy can run it against a stand-in, and an ast-grep rule flags a new daily-only branch with no test naming
   it. The Rust code refers to the daily kind in about 70 places today.
3. Run the browser specs a change can reach on every pull request, through `scripts/affected-tests.mjs`. The full
   set stays on the pre-ship run. This needs item h's quarantine first, or the old flakes come straight back.
4. For crews: a project with a UI gets the real-app recipe as a gate on UI diffs (item c.4). Where the e2e plugin is
   installed, a verified walk is committed and replayed in strict mode on later tasks. A healing step may never
   change an assertion line.
5. Build WP-197a as part of the checker in section 4d rather than as a separate reviewer.

**Where.** Ship path, CI, first mate gate.
**Cost per PR.** About 2 to 5 minutes for the affected browser specs. About 10 minutes once per ship.
**Proof.** Replay the three broken builds (`0.16.17` before #306, before #310, before #334) through the new
pre-ship checks and count how many are stopped. The honest expectation is two of three without the daily-only
seams, three with them.

### h. A queue in front of main, and flaky tests kept out of the way

**Today.** No queue. A pull request is tested against main as it was at the last push and nothing re-runs it when
main moves. The app's merge gate holds only when main changed the same files (`pr_watch/base.rs:424-428`;
`merge.rs:431-432` says "BEHIND alone refuses nothing"). Flaky Rust tests are retried once and a pass on retry does
not fail the job (`.config/nextest.toml:7-9`); the list of flaky tests is printed and never blocks. vitest and
Playwright have no retry and no quarantine. The browser specs contain 63 fixed waits and nothing bans new ones.

**What fails.** PR #344 landed with the build broken and #345 fixed it afterwards. PR #301: three ships in a row
failed, each on a different timing test, with the Mac under load. PR #308: a test written the day before failed six
runs in ten. WP-153: one WebKit test caused 10 of 13 red runs and the lead had started merging past it by title.

**What the sources really say.** GitHub's merge queue is "available in any public repository owned by an
organization". This repo is owned by a personal account, so the native queue is not available. Mergify's free plan
covers open source and includes a queue (not confirmed for personal accounts). Trunk and Mergify quarantine the
same way: the test keeps running and reporting, its failure stops blocking, and a test is quarantined only on
repeated evidence, never after one failure.

**Smallest change.**
1. A merge train in the lead's merge step, about 50 lines: take one ready pull request, merge main into it, wait for
   the checks on that exact commit, merge with the head pinned, repeat. firstmate's `fm-pr-merge.sh` is the model.
2. A quarantine file the tools read (not a table for people): a listed test still runs and reports but cannot fail
   the job, each entry has an owner and an end date, and the check fails when an entry is past its date.
3. Stop new flakes at the door: a new or changed test runs 10 times in CI before it counts (it would have caught
   #308), and an ast-grep rule bans fixed sleeps in tests.
4. For crews: a project switch, "re-test on latest main before merge", that extends the existing hold from "same
   files changed" to "main moved at all".

**Where.** CI and the merge step.
**Cost per PR.** One extra run of the fast checks (5 to 6 minutes of machine time, no person waiting).
**Proof.** A drill: two pull requests that each pass and break together (one renames a function, one calls it). The
train must stop the second.

### i. Property tests on core logic

**Today.** None. No fast-check, proptest or hand-rolled random testing anywhere.

**What fails.** The sandbox and commit-guard reviews went to rounds 7 and 9. Each round was a reviewer finding one
more input the example tests had not tried, which is the search a property test does by itself.

**Smallest change.** Eight modules, one or two rules each, written at the release pass:

| Module | The rule that must always hold |
| --- | --- |
| `src-tauri/src/firstmate/status.rs:151` | A failed gate never reads as done; unsure never reads as passed |
| `src-tauri/src/delivery/merge.rs:411` | Red, pending, draft, conflict or an open decision never merges |
| `src-tauri/src/delivery/events.rs` | One fix round at most; merged and closed are final |
| `src-tauri/src/pr_watch/base.rs:428` | An unknown answer never lets a merge through |
| `src-tauri/src/agent_sandbox.rs` | No path outside the allowed folders is writable, however it is spelled or linked |
| `src-tauri/src/commit_guard.rs` | No push carries a secret in any commit |
| `src/features/autopilot/model/safeApproval.ts` | A protected file never auto-approves, in any spelling |
| `src/features/firstmate/model/fanoutWaves.ts:41` | Every task starts after everything it needs |

Use proptest for Rust (dual MIT/Apache; commit its `proptest-regressions/` folder so every found case stays) and
`@fast-check/vitest` for TypeScript (commit the printed seed as a fixed test). Use the state-machine helpers for
`events.rs` and the resume logic. 64 cases on a pull request, 1,000 nightly. The heavier tools on the list (TLA+,
Kani, Verus, Dafny, Lean) are not worth their cost here yet; pstack's statechart skill already covers the rare case
that needs a model checker.

**Where.** Worker (tests live beside the code) and CI.
**Cost per PR.** Seconds.
**Proof.** Each property is first run against the commit before a known fix (for example before the round-6 sandbox
fixes) and must find the bug by itself.

### j. Measure the pipeline itself

**Today.** Nothing counts escapes. WP-246 (behaviour evals) is a spec with no code. The nightly CI run builds
packages; it tests nothing. `hub-bench` keeps a local trend of its own cases. The work log records outcomes and
rework per task and has no notion of "this bug got out".

**Why it matters.** Without a number, "near zero failures" is a feeling. Rough baseline from git, last 30 days:
5,286 commits on main, about 160 with "fix" as a word in the subject, 2 ships rolled back out of 3 attempts on
12 Nov. The outside numbers say the same thing in general: 7.8% of benchmark patches that pass the chosen tests fail
the project's full suite and about 11% are wrong (Wang, Pradel, Liu, ICSE 2026), and in METR's 2025 study none of
15 reviewed agent pull requests was mergeable as it stood, including all 4 that passed the tests.

**Smallest change.**
1. An escape ledger: `docs/hivra/escapes.jsonl`, one line per bug that reached main or Ash's Mac: date, what
   happened, the fix commit, the commit before it, which layer should have caught it, and the test or rule added.
   Section 6 is the first twelve entries.
2. A replay script (no framework: the SWE-bench case shape is the only part worth borrowing). For each entry, check
   out the commit before the fix, run today's checks, and record whether they now go red. That gives a catch rate.
3. A weekly planted-bug drill: take five recent merged changes, plant one small bug in each with the mutation tools
   from section 4e, run the whole pipeline, count the catches.
4. Publish three numbers on a Hub page each week: escapes per 100 merged pull requests, replay catch rate, drill
   catch rate.

**Where.** Learning loop; a scheduled job on the Mac or a nightly CI job.
**Cost per PR.** None. About an hour of machine time a week.
**Proof.** It is the proof for everything else in this document.

### Also checked: are test files watched?

Partly. The done check counts assert lines and skip markers (`done_check.rs:561-590`), so it catches a deleted test
file, fewer asserts and a new skip. It misses an assertion swapped for a weaker one on the same line, a changed
expected value, a snapshot update, tests inside Rust source files (`#[cfg(test)]` blocks are not seen as test
files), and asserts added elsewhere to offset the ones removed. The test-count gate is opt-in and still counts a
Rust test marked `#[ignore]`. None of it runs for a chat that edits directly, and none of it is in this repo's CI.

Smallest change: put the test-count gate on by default; treat a changed expected value or a changed assertion in an
existing test as a finding unless the brief names that test; read `#[cfg(test)]` blocks; run the same check in CI
for this repo. Mutation testing (4e) is the real answer to a hollowed-out test; this is the cheap first line.

### Also checked: do workers get only the failing test output?

No. "Never paste test output" is a sentence (`agentAppTasks.ts:552`). The only trimming in code is on the app's own
evidence (the last 2,000 characters, `gates.rs:51`). token-saver's approach is a hook that rewrites the test command
to print only failing lines; its pattern does not match `vitest` or `cargo nextest` and its five-line tail can cut
the summary line that section 4b depends on.

Smallest change: give workers one tool, "run checks", that runs the project's affected tests, saves the full log to
a file, and returns the summary line, the failing tests with their messages, and the log's path. That one tool also
feeds 4b (the app sees every run) and 4c (the proof is captured by the app).

## 5. One picture of the pipeline after these changes

1. Ash asks. The first mate writes a brief whose checks are commands with expected results, stamped with a commit.
2. The worker starts only if nothing in scope moved since the stamp. It sees a failing test before it fixes a bug.
   It runs checks through the app's tool and sees only failures.
3. The worker says done. Code runs the gates, chosen from the diff: the brief's checks, the project's checks, the
   test guard, the real-app recipe when visible files changed. Zero tests run is not a pass.
4. A checker on a different model family re-runs the proof on a read-only copy. Two failed rounds and the brief is
   rewritten around the rule being broken; a third goes up to the first mate, then to the person.
5. On a risky path, bugs are planted in the changed code and the tests must catch them.
6. The merge train tests it on top of the latest main and merges that exact commit.
7. Before a ship: the launch check and verify-live on the built app.
8. Anything that still gets out goes in the ledger, becomes a test and, where it has a shape, a rule. The weekly
   drill says whether the numbers are improving.

## 6. The first twelve ledger entries (all from this repo, Oct to Nov 2026)

| # | When | What got out | Caught by | Layer that should have |
| --- | --- | --- | --- | --- |
| 1 | 12 Nov, #306 | 0.16.17 crashed 2 s after launch (object released twice, daily app only) | Ship trial, rolled back | g |
| 2 | 12 Nov, #310 | Ship rolled back: a Terminal ship is unsigned and the new build refused it | Ship trial | g |
| 3 | 12 Nov, #311 | Any failure to open the runner lock read as "runner is live" | Review | d, e |
| 4 | 12 Nov, #303 | Script tests had never run in CI; 4 failed when they did | By accident | c, j |
| 5 | 12 Nov, #303 | 37 test files that pass when the feature is broken | Clean-up | e |
| 6 | 12 Nov, #308 | A new test failed 6 runs in 10 and stopped the ship checks | Mac run | h |
| 7 | 12 Nov, #301 | Three ship attempts failed on three different timing tests | Mac run | h |
| 8 | 12 Nov, #334 | Provider sent an array, every chat on that model failed, shown as "out of credit" | Ash | g |
| 9 | 12 Nov, #304 | A hung git process alive for two days | Ash's Mac | f |
| 10 | 12 Nov, #344 and #345 | Main's build broken by a merged change | Main CI, after | h |
| 11 | 11 Nov, #208 | Seven review rounds of real holes after green tests | Review | d, e, i |
| 12 | 30 Oct, `be83b40d` | A worker removed another worker's finished route and its test | Bench run | a, d |

Two older ones belong in the file as well: the 16 Oct identity trap (AGENTS.md) and the 30 Oct check that "was
refused and never ran" (`33fb31b1`).

Tally: real-app checks would have stopped three, the queue and quarantine three, a checker that runs things three,
"zero tests is not a pass" one. No layer stops all of them, which is the argument for stacking.

## 7. The five changes to make first

Ranked by escaped bugs prevented for the cost. Each is small because the hard part is already built.

1. **Make the gate impossible to walk past.** Gates chosen from the diff instead of a flag, "zero tests ran" is not
   a pass, an accept needs a reason and is shown to Ash, the test-count guard on by default (4c and the test-file
   check). Small code changes in files that already exist; no extra cost per task.
2. **Run the real app before a ship and on visible changes.** Launch check and verify-live inside `hub:check-all`,
   seams for the daily-only paths, affected browser specs on pull requests (4g). This is the layer that would have
   saved the most of Ash's time this month.
3. **Keep main and the tests honest.** The merge train, a quarantine file with end dates, new tests run ten times,
   a fix must change a test, and the first three ast-grep rules (4h and 4f). All plain scripts, all cheap.
4. **Make "done" a runnable contract, and let the checker run it on another model.** Brief checks as commands with
   expected results and a commit stamp (4a); a checker with a read-only copy from a different model family; the
   two-rounds-then-rethink cap (4d). This costs real money per code task, so it scales with risk.
5. **Measure it, and plant bugs to prove the tests.** The ledger and replay, the weekly drill, cargo-mutants on the
   diff for risky Rust paths as a report first (4j and 4e). Without this there is no way to know the first four
   worked.

After those: the red-before-green check (4b), property tests on the eight modules (4i), the "run checks" tool, and
mutation testing for TypeScript once the Stryker trial is done.

## 8. What the research list got wrong or left out

Found by opening each source. None of these changes the direction; several change what to copy.

- **GitHub merge queue** is not available to this repo (organisation-owned public repos only).
- **TDD Guard** uses a model call per edit and one state file per project. It does not tell a failing assertion
  from a broken build in code. Its author's successor is Probity. Alonso's summary-line rule is the part to copy.
- **Claude Code's `TaskCompleted` hook** exists but fires for Claude's own task list and agent teams, not for "the
  worker says done". Stop and SubagentStop are the events for that. All hooks are Claude Code only.
- **fable-judge "5 of 5 on Haiku"** is two runs on one fixture written by the repo's author.
- **Meta's 74** are privacy incidents in the first half of 2026 where the tool "played a key role"; 40% of its
  findings were false alarms.
- **METR, Aug 2025**: 0 of 15 reviewed pull requests were mergeable (not 18), and only 4 of the 15 passed the tests.
- **CodeRabbit** was second on bugs found in the Signal65 study (93 against Qodo's 129), and the study was
  commissioned by CodeRabbit. Bugbot now bills per review, about $1 to $1.50. Macroscope's own test puts the range
  at 18% to 48% and placed Macroscope first. Treat every vendor benchmark as unproven.
- **OpenAI's 1,500 pull requests** were merged with "minimal blocking merge gates" on purpose; the article says
  that would be "irresponsible in a low-throughput environment". The parts to copy are the lint messages that tell
  the agent the fix and the short AGENTS.md map.
- **Google's harness article** is about testing the harness's own behaviour from its tool calls, not a four-layer
  test stack. That idea fits the fake-Claude bench: assert "the worker ran the declared check before saying done".
- **Anthropic's sprint contract** was dropped for newer models in the same article; the planner and one final
  evaluator pass stayed. No pass mark is published.
- **Wang et al. (ICSE 2026)**: 7.8% is the share failing the full suite; the share behaving differently from the
  real fix is 29.6%, and about 11% are judged wrong.
- **e2e** is at `e2e-inc/e2e` (the watch list had the old name). It does not drive desktop windows. The 15 Jan 2027
  shutdown date for the old service is not stated in the repo.
- **Playwright's healer** can edit assertions and is only told not to.
- **Motion Debugger** is plain code, not a model critic, and is tuned to landing pages.
- **Ralph loop** has no round cap in the article; the cap is ours to add. Superpowers caps fix rounds at five.
- **BMAD** has moved from story files to one plan file with a frozen intent block. **Tessl**'s site no longer
  describes spec-as-source. **Shortest** has been quiet since May 2026, not August.
- **AFL++** is AGPL as a whole, as listed. **proptest** and **Kani** are dual MIT/Apache.
- **pstack** has no hooks. Its mechanical parts are a plan linter (`poteto-mode/scripts/check-plan.mjs`), a decision
  log script and the statechart checker.
- **firstmate** has far more than a turn-end guard: about 50 hook and gate scripts. Dropwave ported the contract and
  the merge rules but not the stop guard or the "done names a commit that exists outside the worktree" check.

Every repo on the list is now in `docs/hivra/upstream-watch.json` (40 added; the two with no usable licence are
marked ideas only).

### Sources not taken, and why

- Spec systems that keep a spec library alive (spec-kit, OpenSpec's archive, Tessl, Kiro): too much to read for the
  gain. The brief's check lines do the job.
- Formal tools (TLA+, Kani, Verus, Dafny, Lean) and fuzzers (OSS-Fuzz, AFL++): wrong cost for this stage. OSS-Fuzz
  would not accept the project. Revisit for one parser if untrusted input becomes a problem.
- Browser libraries that are not test tools (Stagehand, browser-use, Playwright MCP beyond what the browser plugin
  already does).
- Paid review bots as a gate. One may be worth trying as a second net (question 3).
- Hosted merge queues and quarantine services: the scripts in 4h do the same for a repo this size.
- Python tools (mutmut, Hypothesis, Schemathesis, Inspect AI): relevant only as optional gates for crews working on
  Python projects.
- Council of High Intelligence for routine work: many model calls per decision. The room and council features
  already cover hard calls.

## 9. Order of work

**At the release pass (when Ash says the next full version is ready).** Beside the full review and full tests
already planned:
1. Run cargo-mutants on the diff since `7398d92c` for the risky Rust paths and read the survivors.
2. Write the eight property tests and run each against the commit before a known fix.
3. Add the launch check and verify-live to the pre-ship run.
4. Start the ledger with section 6 and run the first replay.

**Right after the release.** Changes 1 to 3 from section 7. They are small, mostly scripts and gate tweaks, and they
do not slow a pull request by more than a few minutes.

**Then.** Changes 4 and 5, with the checker scaled by risk so a small task stays cheap.

The 30-minute pull request target holds: the added blocking time is one more run of the fast checks in the merge
train and the affected browser specs. Everything slower runs only on risky paths, before a ship, or weekly.

## 10. Open questions for Ash

Only the ones that are Ash's to answer. Everything else above has been decided in the text.

1. **How strict by default for other people's projects?** The plan above is strict by default (gates from the diff,
   a reason to accept) with a per-project "relaxed" switch. The other way round is friendlier on day one and lets
   more through.
2. **What number means "near-certain"?** Proposed target: no rolled-back ship, and fewer than one escaped bug per
   50 merged pull requests, counted monthly from the ledger.
3. **Try a review bot as a second net?** CodeRabbit is free for public repos. It would comment on pull requests and
   never block. It needs Ash to install its GitHub app.
4. **Spending on the checker.** A checker that runs things costs roughly 10 cents to a dollar per code task. The
   plan assumes yes for code tasks and no for docs and tiny changes.
