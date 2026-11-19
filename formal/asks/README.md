# Asks: can "a long rant never loses an ask" be checked?

A research spike. It changed no product behaviour: everything here is under `formal/asks/` plus new test files. Bugs
found are documented with a minimal trace and pinned by a test. **Four were then fixed by `sc-17-ask-fixes`: A1, A2, A5
and H1** (marked **Fixed** in B.3; their pinning tests were flipped to assert the correct behaviour). **D1 was then fixed
by `sc-19-reset-reparent`** (marked **Fixed** in B.3 too), and **A7 by `sc-20-quiet-ask`** (the same). The rest are not fixed.

**Status, up front**

| Part | State |
| --- | --- |
| Fixes (`sc-17-ask-fixes`) | A1, A2, A5 and H1 fixed, each with its pinned test flipped. Asks.qnt's two A1/A2 knobs follow the fixed code. A3, A4, A6 to A10, H2 to H6, D and N gaps are as they were. |
| One ledger (`sc-18-one-ask-ledger`) | **Ledger B is no longer a store.** Ledger A is the one source of asks; the Chief's "You asked" chip, the dump check and the check card read it through `asks/model/askedView.ts`, a hub chat no first mate hears is written into it (`hubRoute.ts`), the old key's open rows were moved in once (`askMove.ts`), and a delegation carries ledger ids so a job's end updates its ask (`askJobs.ts`). **Fixed: D5, H5 (the two-ledger finding), H6 (Ledger B is gone), A6 (a lone short ask is written, quietly), H2 (on the combined path), and H1 (re-run on the one ledger).** Section 0 below is the map **after** this change; where it says what was, it says so. |
| A quiet ask reaches the person (`sc-20-quiet-ask`) | **A7 fixed in the code.** An open ask that two daily checks found with nothing moved becomes one Needs you row, once per quiet spell (`asks/model/askQuiet.ts`, `needs/model/quietAsks.ts`); its card offers Answer it, Let it go and Remind the first mate. `asks.qnt`'s `ESCALATE` knob is now on by default. **The Quint runs for it were not done: the command needs an approval this run could not get** (see B.1). |
| Step 0, the map (below) | Done. Each claim is tagged: **[T]** pinned by a test in this PR, **[E]** measured by the eval run, **[R]** read by me in the code, **[M]** reported by a read-only mapper and not re-checked by me. |
| A. Extraction eval (`eval/`) | Done and run (`node formal/asks/eval/run.mjs`). The "recorded" model replies are **simulated**, not captured from the app's engine (see A.3). |
| B.2 fast-check model-based test | Done and run against the real store. Passes; bites on two deliberately broken reducers (B.2). |
| B.1 Quint model (`asks.qnt`) | **Typechecked and run on 13 Nov 2026** (`quint run`, rust backend, 20,000 samples per invariant). Every result matches the table in B.1; outputs and seeds in `quint-output/`. Apalache `verify`: not tried. |

## Run it

```bash
node formal/asks/eval/run.mjs                      # extraction recall, offline (the saved output is eval/REPORT.md)
node formal/asks/eval/run.mjs --mode hub           # a hub chat no first mate hears, as the app writes it now (rules + the old hub regex)
node formal/asks/eval/run.mjs --mode hub-old       # the old hub ledger's regex alone: the baseline the hub path must not fall below
npx vitest run src/features/asks/testbed/askEval.test.ts src/features/asks/model/askStore.property.test.ts \
  src/features/asks/model/asks.gaps.test.ts src/features/asks/hooks/useAskLedger.gaps.test.ts src/features/hub/model/askLedger.gaps.test.ts
npx @informalsystems/quint typecheck formal/asks/asks.qnt                       # passes
npx @informalsystems/quint run --max-samples 20000 --invariant inv_touchedNeverGone formal/asks/asks.qnt
```

---

## 0. The map

### 0.1 Four different things were called "ask", and now three are connected

| Name | Where | Holds | Fed by |
| --- | --- | --- | --- |
| **Ledger A**, the ask ledger (**the one source of asks**) | `src/features/asks/model/{asks,askStore,askNotes,askJobs,askMove,askedView,hubRoute,wideReading}.ts`, `hooks/{useAskLedger,useAskJobs}.ts`, `ui/{AskReceipt,ChiefGlance}.tsx`; one document `asks` in the local hub database (`src-tauri/src/local_hub.rs`) | Every ask Ash made in any hub chat, statuses `heard maybe started waiting done dropped`. A row can be **quiet** (a lone short ask, an ask in a chat that is no first mate's, a row moved from Ledger B): on the Chief's list, no receipt under the message, no first mate told, until someone moves it | `useAskLedger` (the wide reading, and the model for a long message), `hubRoute.ts` (a hub chat no first mate hears), Ash's "Add one that was missed", the first mate's `asks.update`, **a job's end (`useAskJobs` → `askJobs.ts`)**, the dump check's settle (`askSettle.ts`) |
| **Ledger B**, the old hub ask ledger (**retired as a store**) | `src/features/hub/model/askLedger.ts` (now the pure regex reading `extractAsks` and the evidence code); `localStorage` key `monocode:hub-ask-ledger` | Nothing new. The key is kept **read-only for one release**: nothing writes it, and `readLegacyAskLedger` reads it once, to move its open rows into Ledger A (`askMove.ts`). The release after this one deletes it | — |
| **Jobs** (delegations) | `src/features/monos/model/delegations.ts`, `src-tauri/src/delegations.rs`, `firstmate/status.rs` | Work handed Chief → first mate → crew. Status `working paused needs-you done failed`. **`askIds` now carries ledger ids** (`ask-<n>-<block>`, the `id` in `asks.list`), and the old `a_...` ids are still accepted | `tasks.delegate`, `captain.handoff` |
| **Decisions / Needs you** | `src/features/needs/**`, `src-tauri/src/decisions.rs` | Questions and approvals waiting on the person | `decisions_ask`, stuck workers, gates, tasks, PR watches |

Not asks: `src/features/inbox/model/inboxAsk.ts` is the prompt for asking a question about a GitHub or Linear inbox
item **[R]**. The `asks: ["a_..."]` field on a **PR watch** still carries ids from the retired Ash OS; it was not changed.

The spec for Ledger A is `docs/specs/mono-chat-memory.md` section 6 ("nothing Ash asks can be lost"). Ledger B predates it.
**Before sc-18 nothing connected A, B, jobs and Needs.** Now A, B (folded in) and jobs are connected, and **since sc-20 an ask that went quiet reaches Needs** (gap A7, fixed): the Needs you list reads the ledger's raised asks.

### 0.2 Where an ask is born

**Ledger A** (`useAskLedger.ts`, main window of the Hub bundle only), for each of Ash's messages to a first mate (`askMate.ts`:
a first mate's own chats and a coding team's chat with its lead; never a room, a worker or a plain chat) **[R]**:

1. Skip a message from before the ledger began (`doc.since`), a draft, an app note (`[MonoCode ` prefix), a slash command, a
   bare "ok" or "thanks" (`asks.ts nothingToHear`).
2. **Quick reading at once** (`wideReading.ts wideAsks`, sc-18): each sentence the rules read as an ask (`asks.ts looksLikeAsk`:
   `can you`, `please`, `make sure`, `I want`, `we should`, a question mark, a leading verb from a fixed list), **plus each
   sentence the old hub ledger's regex found** (a complaint like "the search is slow", a bare question) that none of those
   already is, in message order. It reads a short two-sentence message as two asks (the rules alone take it whole).
3. **Always written, loud or quiet** (`useAskLedger.ts`): every ask the quick reading holds is written. Whether the chat shows
   it is still the rules' call (`worthKeeping` on `rulesAsks`: two or more asks, or one ask in a long message, 200+ characters
   or 3+ sentences): when it says no, the rows are **quiet** (gap A6 fixed, sc-18).
4. **Model reading** for a long message, in the background (`isolatedCompaction`, a Claude text call with a 180 s limit,
   `app/hooks/useMonoTrees.ts:26`): `hearPrompt` asks for a JSON list of `{quote, summary, kind}`. `parseHeard` keeps an item only
   if its quote is in the message word for word (so the model cannot invent an ask). At most `MODEL_TRIES = 2` tries; the
   second waits until the chat is idle. Each try, good or bad, is counted.
5. **Safety net** (`hearMessage`): any sentence the rules read as an ask that no model quote covers (60% word overlap) is added
   as a `maybe`, at most 6 per message.
6. **Replacement** (`withHeard`): hearing a message again replaces that message's rows nobody has touched with the new
   list (new row ids, new numbers). A row with a status, a note, or Ash's hand on it is kept.

**A chat that is no first mate's** (a plain chat, a team room; sc-18): `dumpCheck.noteDumps` still notes every "dump" message (any
ask, 280+ characters, or 3+ lines) and hands each new one to `onNew`; the app passes `hubRoute.ts routeHubDump`
(`useHubChecks.ts`), which, when `askMateFor` finds no first mate for the chat, writes the wide reading (**no cap of six**) into
Ledger A through `store.hear`, owned by `HUB_MATE` (`hub.chats`), **quiet**, with the time Ash sent it. A message is heard once. The
old path (`recordAskText` → a second copy in `localStorage`) is gone. A separate isolated "look" later compares each dump with the
reply and the build (`dumpCheck.ts lookAtDumps`); when nothing was missed it closes, in Ledger A, the asks the build covers.

**The one-time move** (`askMove.ts`, `useAskLedger.ts`, first start after sc-18): the old key's rows that are still open and that
Ledger A holds no match for (same message block and the same quote, or the 60% word overlap) are copied in, marked `moved` and quiet,
in one revision-checked write that also sets `hubMoved`, so a second start, or a second window, copies nothing. Closed rows are
not copied. An unreadable key leaves the move undone for the next start. The key is never written or deleted.

### 0.3 Where an ask is stored

| | Store | Concurrency | Caps |
| --- | --- | --- | --- |
| Ledger A | `hub_local_docs` document `asks` through `askStore.ts` | Revision compare-and-swap; 5 tries; one write queue per window; `local-hub://changed` makes other windows re-read (`askStore.ts:76-102`) **[R]** | closed rows 2000 (oldest out), "heard" marks 4000, history 20 steps (`asks.ts:66-77`). Open rows are never capped. |
| Ledger B (retired) | `localStorage`, **read only** since sc-18 (one release, then deleted) | none: nothing writes it (it had no compare-and-swap, H6) | none (it had the newest 400 rows, open or not, until H1) |
| Jobs | SQLite `delegations` (`src-tauri/src/delegations.rs:71`) | one connection | log 50 lines; none for rows |
| Decisions | SQLite `decisions`, steering rows | `Immediate` transactions; stale answers get `applied: false` | open list 200 **[M]** |

### 0.4 Handed Chief of Staff → first mate → crew

- The Chief files a task then calls `tasks.delegate` to a project's lead (`captain.handoff`, `agent-app/model/agentApp.ts:1928-1975`)
  **[M]**. The Chief never starts crew itself. "Working" on its screen is a view over every delegation row.
- A first mate (or a coding-team lead) calls `tasks.delegate` for a worker; the row gets `ownerSession` = that chat, a child
  session `app-<caller>-<request>`, and the `askIds` field **[M]**.
- A worker's end is queued to the owner chat as a message (`queueMonoSessionCompletion`, `App.tsx:11201`); the row is the truth
  (`delegations.ts:1-10`), the queued message is saved with the session **[R][M]**.
- **A job is linked to its Ledger A rows (sc-18, gap D5 fixed).** `delegate_task` / `delegate_tasks` take **ledger ids**
  (`ask-<n>-<block>`, the `id` that `asks.list` and every `<open_asks>` line show) in `asks`, beside the old `a_...` ids, which are
  still accepted (`agentAppTasks.ts askIds`, `fanoutContract.ts` pre-check, `delegations.rs ask_id_ok`). `useAskJobs` applies the
  delegation rows to the ledger whenever they change (`askJobs.ts withJobs`, one revision-checked write): a working job takes its
  ask to `started` (the id is kept on the ask); a job whose shown status is **done** (gates passed, no gates, or accepted by its
  first mate) makes it `done` with the gate verdict and the report's summary as proof; a **failed or cancelled** job sends it back to
  `heard` with a note; `paused` (a usage limit) is not an end. An ask the person dropped is never touched; an ask waiting on Ash stays
  waiting; a result is applied only to an ask nobody moved since the job settled (a late result never overwrites a later word, a
  reopened ask stays open); an ask another job still works on waits for that job. **[T]**
- Open asks travel to a first mate as an `<open_asks>` note beside Ash's next message, and always into a fresh session
  (`App.tsx:10272-10282`, `askNotes.ts openAsksNote`) **[R]**.

### 0.5 States and transitions

**Ledger A** (`asks.ts`, `askNotes.ts`, `App.tsx:15669-15690`, `AskReceipt.tsx`) **[R]**

| From → to | Trigger | Actor |
| --- | --- | --- |
| none → `heard` | message heard (`withHeard`), `by: rules` or `model` | app |
| none → `maybe` | safety net, a sentence no model quote covers (≤ 6) | app |
| none → `heard` | "Add one that was missed" (`withAdded`) | person |
| `heard`/`maybe` → replaced | the message is heard again and the row is untouched (`withHeard`) | app |
| `heard` → `started` (note "Handed to a worker: …", job id kept on the ask) | a delegation carrying the ask's id is working | app (`askJobs.ts`) |
| `heard`/`started` → `done` (proof: gate verdict + report summary) | the job's shown status is done | app (`askJobs.ts`) |
| `started` → `heard` (note: why the job failed or was cancelled) | the job's shown status is failed | app (`askJobs.ts`) |
| `heard`/`started`/`waiting` → `done` (proof: what closed it), or a note on it | the dump check: a "Right" answer, a "Fixed" or a done claim the build covers (`askSettle.ts`) | app |
| any but `dropped` → `started` | `asks.update` | first mate |
| `heard`/`started` → `waiting` (needs a note) | `asks.update` | first mate |
| any → `done` (first mate needs a non-empty proof string) | `asks.update`; "Mark done" | first mate, person |
| any → `dropped` | "Drop this ask", "Not an ask" | **person only** (`changeProblem` refuses the first mate) |
| `maybe` → `heard` | "Yes, this is an ask" | person |
| `done`/`dropped` → `heard` | "Reopen" | person (the first mate cannot revive `dropped`) |
| closed → evicted | more than 2000 closed rows, oldest first (`askDocForDisk`) | app |
| told | turn-end nudge: an app message naming still-`heard` asks, at most twice since Ash's last message, only into an idle chat whose last block is a reply (`askNotes.ts askNudge`) | app |
| told | daily check: one app message naming asks `heard` for 24 h or `started` and quiet for 3 days, at most every 20 h, **addressed to the chat of the oldest such ask** (`askDigest`; hook `useAskLedger.ts:174-196`) |
| counted (sc-20) | the same daily check, when it is marked (`withDailyCheck`, askQuiet.ts), adds one to `Ask.chase.checks` on every ask it names, and on a `waiting` ask unmoved for 3 days (a check with nothing to tell the first mate is still made for those). A check marked again inside 20 h counts nothing. | app |
| raised (sc-20) | the second counted check sets `chase.raisedAt`: the ask is a Needs you row (`raisedAsks`). Once: a raised ask is not counted again. The count is good only while `chase.at === ask.updatedAt`, so **any change to the ask** (status, note, reopen) ends it, the row goes, and a later quiet spell counts from nothing. A maybe, an idea, an untouched lone short ask and an ask heard in a chat that is no first mate's are never counted. | app |
| row answered (sc-20) | **Let it go** → `dropped` by `ash` (the existing person-drop path, only for the row the card was drawn for); **Remind** → `chase = {checks: 0, remindAt}` (the row goes; `useAskLedger` sends one app message to the ask's chat, or another chat of that first mate that is idle, then clears `remindAt`; the same message id twice is a no-op); the card's box, or any message from Ash in that chat after it was raised → `chase = {checks: 0}`. **Answer it** opens the chat on the message and writes nothing. | person, app | app |

**Ledger B** (retired; this is what it did, **[R]** before sc-18): new → `open`; `open` → `open` (said again: `said + 1`, words
replaced); `handled` → `open` (said again); `open` → `handled` (a "Right" answer, a "Fixed" the build covers, or a done claim the
build covers, `settleAsks`; or a look that found nothing missed and the build covers it); a row is evicted at 400.
`parked` and `dropped` existed but no non-test code set them. **Now in Ledger A:** `open` ≈ `heard`/`started`/`waiting`, `handled` ≈
`done`, and the settle writes `done` with its proof (the rows above). A repeat while the ask is open still lands on its row (`said + 1`,
`asks.ts withHeard`; "Please fix the save bug!" is "fix the save bug"); **a repeat after it was closed is a new open row** beside the
finished one, where Ledger B reopened the old row.

**Jobs** **[M]**: `state` `running → question ⇄ running → completed | failed | cancelled`; `delivery`
`pending → queued → delivered → acknowledged | disposed`; shown status `working paused needs-you done failed` derived in Rust
(`firstmate/status.rs:193-292`). A cancel sets `disposed`. A failed or cancelled row can go back to `running` with a new generation.

**Decisions** **[M]**: `open → answered` (`answer_both`, which also releases the waiting workers' steering rows in one
transaction), `retire`, a standing-answer flag. No expiry or supersede. "Set aside" is client-side, 24 h.

### 0.6 The six scenarios

(The Ledger B column is what it did before sc-18. Its rows now live in Ledger A, so for the same scenario read the Ledger A column;
the one new fact is that a job that ends updates its ask, see 0.4.)

| | Ledger A | Ledger B | Jobs | Needs / decisions |
| --- | --- | --- | --- | --- |
| **App restart** | Rows persist. The hook re-hears any message with no "heard" mark (`since` rule); an in-flight reading is lost and redone. **[R]** | Rows and dump notes persist; a check claimed but not yet delivered is lost (H4). **[M]** | Rows persist; boot recovery in one window: drop/cancel/settle, re-queue unreported (`delegations.ts:437-473,952-991`). A cut worker is settled from its transcript with no gates (D2). **[M]** | Rows and steering rows persist and are drained at start. **[M]** |
| **Retry** | Two model tries; a failed try is counted and the rules' reading stands; a repeat of one message replaces untouched rows (A1-A4). **[R][T]** | A repeat lands on the same row; a failed look is **not** retried (H3). **[T]** | Auto-resume of a cut turn: 3 times, then a "resume stopped" note (`inFlight.ts:26`). **[M]** | Steering delivery: 5 tries, every 30 s. **[M]** |
| **History compaction** | The ledger is untouched. A fresh session always gets the `<open_asks>` note; the state card (`stateCard.ts`) lists rules, decisions and finished asks, not open ones. **[R]** | Not involved. | The tidy brief keeps exchanges only: no open-job content. Queued reports go into the fresh session. **[M]** | — |
| **Cancellation** | Only the person can drop. A retraction in the same message ("scratch that") is not detected by either extractor (A.2: withdrawn asks stay open). **[T]** | `dropAsk`/`parkAsk` never called. | Owner Stop, `task_cancel`, trashing a mate cancel and dispose the row. **Resetting**, archiving or deleting a first mate's chat moves its open rows to the chat that takes its place (D1, fixed by sc-19-reset-reparent). **[R][M]** | Nothing cancels a decision. |
| **Worker crashes** | Nothing is written. The ask stays `started` until the first mate acts; the daily check names it after 3 quiet days, into the oldest quiet ask's chat or, if that can't take it, the next quiet ask's (A5, fixed). **[T]** | `askSettle` compares the chat's build with the ask, so a crash leaves it open. | The turn settles `failed` and a failed report is queued to the owner. A failed row leaves every list after 6 h (D6). **[M]** | A stuck worker becomes a Need only if it needs Ash; otherwise grey and gone after 6 h. **[M]** |
| **First mate's turn is cut** | Auto-resume (≤ 3); the resumed turn gets the `<open_asks>` note again if the list changed. **[R]** | — | Its rows are untouched; queued reports survive in the session queue. **[M]** | — |

### 0.7 What the spec promises, and what the code does

`docs/specs/mono-chat-memory.md` §6, line numbers from `:412-496`.

| Promise | Code |
| --- | --- |
| "Rows are never deleted" (`history` row) | **No.** Untouched rows a hearing wrote are replaced on a re-hearing (by the list that replaces them; A1 and A2 are fixed, so a hand-added ask and an ask the model left out are kept); closed rows past 2000 are evicted. |
| "Quotes are checked, not trusted" | Yes (`parseHeard` → `quoteIn`). |
| No-model backstop adds uncovered sentences as `unclear` | Yes, all of them (the cap of 6 went with A2's fix); "covered" is a 60% word-overlap guess. |
| "Short messages skip the model. One sentence is one ask" | The ask is written (sc-18, A6 fixed), **quietly** unless the message is long or holds 2+ asks: the Chief's list has it, no receipt shows under the message. |
| "A repeat joins, not doubles… attached as a second quote" | It bumps `updatedAt`; no second quote is kept. |
| Turn-end check "at most twice. After that the asks stay open, in red, in **Needs you**" | The nudge and its cap are enforced. **The Needs part is now built (sc-20, A7)**, counted in daily checks (the spec's "after two nudges" is the turn-end nudge, which lives in the chat's own blocks and is capped per Ash message; the ledger counts the daily check, which it owns). |
| "Done needs proof… a link the app can check exists" | A non-empty string. |
| "Dropped is Ash's word" | Yes, stricter: the first mate can never drop. |
| "Open asks are always in front of the Mono… at every session start" | Yes for first mates (`openAsksNote`). |
| "A checker at the end… the open asks for that job go to the done checks" | **Now yes, in part (sc-18):** a job carrying a ledger id closes or sends back its ask when it ends (`askJobs.ts`), with its gate verdict as the proof. The dump check also settles open asks against the build (`askSettle.ts`). |

---

## A. Extraction completeness: measured, not proved

What counts as an ask is a judgement, so "no ask is missed" cannot be proved. It can be measured.

### A.1 What is in `eval/`

| File | |
| --- | --- |
| `messages.json` | 10 long, messy messages, each starting `Example:`, written fresh (no real chat). 52 labelled asks (3 to 7 each), plus 3 asked and withdrawn in the same message, 2 repeated asks, 2 pasted sentences that are not Ash's. Each ask is labelled with a verbatim `anchor`, a kind, and whether it is implicit or buried. |
| `lib.ts` | The harness. It **imports** the app's pure code (`asks.ts`, `askStore.ts`, `useAskLedger.ts`'s `isLongMessage` and `worthKeeping`, `askLedger.ts extractAsks`) and runs it on an in-memory disk. The effect body inside the React hook cannot be imported, so `hearLikeApp` follows it line by line. `src/features/asks/testbed/askEval.test.ts` renders the **real hook** on the same message with the same model call in 7 cases and fails if the two ledgers differ. |
| `run.mjs` | The CLI. It loads those TypeScript files through Vite's server-side loader. The model call is an **injected function** `(prompt) => Promise<string>`. Modes: `hub`, `rules`, `oracle`, `recorded`, `live`; stress options `--lazy N` and `--fail-first N`. Not wired into CI. |
| `recorded/typical.json` | The recorded replies (see A.3). |
| `REPORT.md` | The saved output of `node formal/asks/eval/run.mjs`, with the per-message tables and every missed ask. |

### A.2 Results (10 messages, 52 asks)

"Own row" = the ask is a row of its own whose quote holds the labelled words. Run on this branch.

| Run | Own row | + "maybe" lines | Missed | Implicit own row | Buried own row | Withdrawn still open (of 3) |
| --- | --- | --- | --- | --- | --- | --- |
| **hub-old**: the old Ledger B extractor alone (regex, 6 per message), the baseline | 62% (32) | 62% | 11, and 9 merged into another ask's row | 4/7 | 2/5 | 1 |
| **hub**, sc-18: a hub chat as the app writes it now (`hubRoute.ts`: the wide reading, no cap) | **67% (35)** | 67% | **8**, and 9 merged | 4/7 | 2/5 | 1 |
| **rules only** (Ledger A, no model), *before sc-18: the rules alone* | 33% (17) | 33% | 27, and 8 merged | 0/7 | 1/5 | 1 |
| **rules only**, sc-18: the wide reading (what the app keeps with no engine) | **67% (35)** | 67% | **8**, and 9 merged | 4/7 | 2/5 | 1 |
| **oracle** (a model returning exactly the labels) | 100% (52) | 100% | 0 | 7/7 | 5/5 | 0 |
| **recorded** (simulated typical model), *before sc-18* | 92% (48) | 92% | 4 | 4/7 | 5/5 | **3** |
| **recorded**, sc-18 | 92% (48) | **98%** | **1** | 4/7 | 5/5 | **3** |
| recorded, model names only its first 2 asks, *before sc-18* | 35% (18) | 58% | 22 | 3/7 | 0/5 | 2 |
| recorded, model names only its first 2 asks, sc-18 | 35% (18) | **81%** | **10** | 3/7 | 0/5 | 2 |
| recorded, first call per message times out | 92% (48) | 98% (was 92%) | 1 (was 4) | 4/7 | 5/5 | 3 |
| recorded, **both** calls time out, *before sc-18* | 33% (17) | 33% | 27 | 0/7 | 1/5 | 1 |
| recorded, **both** calls time out, sc-18 | **67% (35)** | 67% | **8**, and 9 merged | 4/7 | 2/5 | 1 |

*Before and after, `--mode hub` (a hub chat no first mate hears):* the old regex alone held 32 of the 52 asks as a row of their own,
9 merged, 11 missed; the combined path holds **35, 9 merged, 8 missed**, and is not worse in any one of the ten messages
(`askEval.test.ts` asserts it, in total and message by message). It gains where the rules read an ask the regex did not (m02, m07).
The other rows moved too, because the hook and the no-model safety net now read with the wide reading: with no working model the
ledger holds 35 of 52 where it held 17. The cost is noise from the regex's looser reading: unlabelled rows and "maybe" lines (7
unlabelled "maybe" lines on the oracle run, where there were 3).

What it says:

- **The pipeline is sound when the model is good**: the oracle run loses nothing (also asserted in the test).
- **With no working model the ledger held a third of the asks (before sc-18).** Two failed tries are final (no timer, no third
  try), so a provider outage during a rant left Ledger A at 33%. The old hub extractor did better (62%) because its regex is
  broader, but it stopped at 6 per message and merged a one-sentence run-on into one row. **Since sc-18 both outage rows read with
  the wide reading and hold 67% (35 of 52)**, with no cap of six; the merged run-ons (m04, m08) are still merged, an unchanged
  limit of reading by sentence.
- **The safety net helps**: when the model names only 2 asks, "maybe" lines raised recall from 35% to 58%, and to 81% since sc-18.
- **Withdrawn asks stay open** in every run: neither extractor understands "scratch that", and a model that lists the retracted ask
  puts it on the ledger as a live one. Nothing later closes it (the first mate must notice).
- **A pasted customer message** puts the customer's requests on the ledger (as asks from the rules, as "maybe" lines after the model).
- Every miss in the recorded run is an **implicit** ask ("the search is slow", "do the same fix on the other page").

### A.3 Limits

- The recorded replies are **hand-written stand-ins**, labelled `SIMULATED` in the file. They measure how the app's code treats a
  reply (quote check, safety net, numbering), not how good a model is. Real recall needs
  `node formal/asks/eval/run.mjs --mode live --live-cmd 'claude -p' --record formal/asks/eval/recorded/live.json`, which calls a
  model and the network, so it was not run.
- Ten messages, labelled by one author, is an illustration, not a benchmark. Add messages to `messages.json`; the test checks every anchor is verbatim.
- The app's engine call is `runHarnessTextPrompt` in Tauri; the eval replaces it with the injected function.

---

## B. Tracking until resolved

### B.1 The Quint model (`asks.qnt`): typechecked and run

Three actors (person, first mate with its crew, app) on one message with three asks (slot 3 is one both extractors miss). It
follows 0.5: rows `heard maybe started waiting done dropped`, replacement on a re-hearing, the maybe cap, the turn-end nudge,
`open_asks` injection, delegation and its report, a worker finishing, a reset that orphans a job, an app restart, a compaction,
time passing, and the person's taps. Knobs at the top say "as the code is today" or "as the spec promises". **Since sc-17-ask-fixes**
`HAND_ASK_REPLACED` defaults to `false` and `MAYBE_CAP` to `9` (never binds with three slots): the code no longer has gaps A1 and A2.
The table and the variants below were run on the old defaults (13 Nov, `quint-output/`); that PR only re-typechecked the file.

```bash
npx @informalsystems/quint typecheck formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_known             formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_touchedNeverGone  formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_dropIsPersons     formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_neverGone         formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_noStarvation      formal/asks/asks.qnt
npx @informalsystems/quint verify --invariant inv_neverGone formal/asks/asks.qnt      # Apalache and Java
```

**Worked out by hand first, then confirmed by a run on 13 Nov 2026** (every row below matched; `quint-output/runs.txt` has each result and its seed, `quint-output/counterexamples.txt` the two violating traces):

| Invariant | Code as it is (default) | Shortest trace I expect |
| --- | --- | --- |
| `inv_known` (exactly one known state) | holds | |
| `inv_touchedNeverGone` (an acted-on ask is never lost) | holds | |
| `inv_dropIsPersons` (only the person drops) | holds | |
| `inv_neverGone` (an extracted ask never disappears) | **fails** (old defaults) | `extract(1), extract(2), rehear(1,omit), rehear(2,omit)`: the second maybe is over the cap (A2). Or `extract(1), handAdd(3), rehear(3,omit)` (A1). Both fixed by sc-17-ask-fixes; with the new defaults it is **expected to hold** (`gone` is only reachable through `rehear`), not re-run. |
| `inv_noStarvation` (bounded liveness) | **fails** with `ESCALATE` off (the code before sc-20-quiet-ask); with it on, the default since sc-20, **expected to hold by hand, not re-run** (see below) | `extract(1), tick ×4`: an open ask is shown to the person nowhere but the receipt. |

Liveness, "every ask eventually reaches resolved or surfaced", is checked in its bounded form (`inv_noStarvation`): no heard or
started ask sits un-surfaced more than 3 days. The **fairness** is in `tick`: with `ESCALATE` on, a day cannot pass while an
escalation is due, which is how you say an action is weakly fair for an invariant checker. The first mate and the person are
**not** assumed fair: the first mate is a model that may ignore a nudge, and Ash may not look. Under that assumption nothing in the
code today surfaces a stuck ask (the daily check goes to the first mate only), which is why this fails.

Variants (copy to a temp folder with the same file name, then run the invariants above):

```bash
mkdir -p /tmp/asks-noescalate && sed -e 's/ESCALATE = true/ESCALATE = false/' formal/asks/asks.qnt > /tmp/asks-noescalate/asks.qnt   # the code before sc-20-quiet-ask (A7): expect inv_noStarvation to fail
# the design (all five hold) is the default file since sc-20-quiet-ask: ESCALATE is on, and A1 and A2 are fixed
mkdir -p /tmp/asks-old && sed -e 's/HAND_ASK_REPLACED = false/HAND_ASK_REPLACED = true/' -e 's/MAYBE_CAP = 9/MAYBE_CAP = 1/' \
  formal/asks/asks.qnt > /tmp/asks-old/asks.qnt                                                  # the code before sc-17-ask-fixes: expect inv_neverGone to fail (A1, A2)
mkdir -p /tmp/asks-bad1 && sed 's/MATE_CAN_DROP = false/MATE_CAN_DROP = true/' formal/asks/asks.qnt > /tmp/asks-bad1/asks.qnt            # expect inv_dropIsPersons to fail
mkdir -p /tmp/asks-bad2 && sed 's/RESTART_LOSES_WAITING = false/RESTART_LOSES_WAITING = true/' formal/asks/asks.qnt > /tmp/asks-bad2/asks.qnt  # expect inv_touchedNeverGone to fail
```

**After the A1/A2 fixes (sc-17), run on 13 Nov 2026 with the new defaults:** `inv_neverGone` now holds; `inv_known`, `inv_touchedNeverGone` and `inv_dropIsPersons` still hold; `inv_noStarvation` still fails, because nothing yet takes a quiet ask to the person (A7, a follow-up). Results and seeds: `quint-output/runs-after-fixes.txt`.

**After A7 (sc-20-quiet-ask): `ESCALATE` is now `true` in the default file. Typechecked and run on 13 Nov 2026 (rust backend, 20,000 samples each): all five invariants hold, including `inv_noStarvation`.** Results and seeds: `quint-output/runs-after-a7.txt`. **What the knob does not model of the code:** `stuck` is `heard` or `started`, so an ask waiting on the person (which the code also counts, after 3 days) is outside it; `told` is never cleared, so the second quiet spell after a status change (which the code raises again) is not explored; Remind (the count starts again) is not an action; time is days, where the code counts daily checks (an ask heard for a day, then two checks a day apart). Turning the knob on is the only change to the model's logic; its comments were updated to say when the code has it.

Before the fixes, the variants were run too: the design holds all five; `bad1` fails `inv_dropIsPersons` and `bad2` fails `inv_touchedNeverGone` (each also fails the two the default already fails), so each invariant is known to bite. The TypeScript test in B.2 does show
the same kind of bite on the real code.

### B.2 The fast-check model-based test (`src/features/asks/model/askStore.property.test.ts`): run

Random interleavings (up to 30 steps, 200 runs) of **extract** (rules or model list, any subset, any maybes), **delegate**,
**complete**, **fail** (the first mate marks it waiting), a **worker crash**, the person's **done/drop/reopen/settle**, a first
mate **trying to drop**, an app **restart** (a new store on the same disk), a chat **compaction** (the fresh session must be handed
every open ask), and a **duplicate delivery**, and (sc-18) the **job-finish steps**: a delegation carrying the ask's ledger id
**starts**, **passes, fails or is cancelled**, and the same rows are **applied again** (a second pass writes nothing). Their
reference model is the rule written out, not `askJobs.ts`: an end applies to an ask nobody moved since; a failed or cancelled
job sends a started ask back to heard with a note and never leaves any ask closed; a passed job closes a heard or started ask
with its proof and leaves one waiting on Ash waiting; Ash's dropped, a done ask and a maybe are never touched. All against the
**real** `createAskStore` on `memoryDisk()` (two stores on one disk
behave like two windows). A reference model, written from the spec and not from the reducers, runs beside it. After every step:
the store equals the model; every ask is in one known state; ids, numbers and quotes are unique; no ask that was ever touched is
gone; the heard marks match; after a restart the doc is identical; after a crash the daily check names the ask. Two more
properties: two windows hearing one message at once end with one copy of each ask, and two windows changing different asks both land.

Result: `npx vitest run src/features/asks/model/askStore.property.test.ts` passes (5 tests since sc-17-ask-fixes; it was 4).

**It bites.** I broke the real reducers twice, ran the test, then restored them (`git status` shows `asks.ts` clean):

| Broken reducer | fast-check |
| --- | --- |
| `withHeard`: `untouched = (ask) => ask.blockId === input.blockId` (replace touched rows too) | `Property failed after 25 tests`, seed 929980264. Counterexample `[extract(blk-a, asks=[1], maybes=[], by=rules), delegate(slot 1), duplicate delivery of the last extract]`, shrunk 6 times. |
| `parseAskDoc`: drop `waiting` rows when reading the document | `Property failed after 17 tests`, seed -494838782. Counterexample `[extract(blk-b, asks=[], maybes=[0], by=rules), fail(slot 3)]`, shrunk 3 times. |

A third test covers gap A1: the same machinery with an "add by hand" step. The property, a hand-added ask survives every hearing,
**failed** until A1 was fixed: the test used to assert that it fails and shrinks to `extract, add by hand, extract` (seed 20261113).
`sc-17-ask-fixes` fixed A1 and turned it into the plain property (two tests: random runs, and that same seed, which now passes).

### B.3 Gaps found, each with its trace and one line on what to do

Tag: **[T]** a test in this PR pins the trace; **[E]** measured by the eval run; **[R]** read by me; **[M]** a read-only mapper reported it, not re-checked.
Severity: *high* = an ask can silently disappear or stay stuck with the person never told.

**Ledger A: first-mate ask ledger**

| | Sev | Gap and minimal trace | Do |
| --- | --- | --- | --- |
| **A1** [T] | high | An ask Ash adds by hand is thrown away when the model's list for its message lands. `withAdded` writes a row with status `heard` and one history step, which `withHeard` counts as untouched. Trace: quick reading writes 3 rows → Ash adds a 4th under the receipt → model list lands → 3 rows (`asks.gaps.test.ts`, `askStore.property.test.ts`). The model call can take up to 180 s, so the window is real. | **Fixed (sc-17-ask-fixes).** `withHeard` replaces only rows whose history steps are all by the app, so Ash's hand-added row (one step, by `ash`) is kept; the tests above were flipped and now assert it survives. |
| **A2** [T] | high | The model's list replaces the rules' rows; rules asks it did not name are kept only as `maybe`, at most 6 (`MAYBE_PER_MESSAGE`). Trace: 8 asks heard by the rules, a model that names 1 → 1 + 6 rows, one ask gone, nothing says so. | **Fixed (sc-17-ask-fixes).** `hearMessage` keeps every uncovered rules ask as a maybe: the cap is gone and `MAYBE_PER_MESSAGE` with it (the quick reading had already written each one down, so a cap only ever dropped an ask the person had seen). Nothing is hidden: the receipt line already counts them ("Heard 1 ask, 7 to check") and the opened list shows every row. The hook's `worthKeeping` check used to write an empty list over a lone rules ask when the model named none; the model's branch now keeps any row (the eval's `hearLikeApp` mirrors it). The tests above were flipped. |
| **A3** [T] | medium | A `heard` ask the model's list left out becomes `maybe`, which is not in the `<open_asks>` note and is not "owed" by the turn-end nudge. The first mate stops being told of an ask the rules and the person may both have meant. | Keep it `heard` and add the model's view as a flag, or list maybes to the first mate too. |
| **A4** [T] | low | Numbers change on a re-hearing: "ask 1" from the quick reading is "ask 4" after the model's list lands, and `asks.update {"ask":1}` returns "There is no ask 1." | Keep a row's number when its quote is unchanged. |
| **A5** [T] | high | The daily check is addressed to the chat of the **oldest** quiet ask. If that chat is not open (closed, or reset and removed) the hook skips the whole check and tries again next pass, forever, and nothing is marked sent. Quiet asks in other, open, idle chats of the same first mate are never named either. Trace: asks 1 (chat-old) and 2 (chat-live) 3 days old, only chat-live open → no message (`useAskLedger.gaps.test.ts`, with a control that sends when both are open). | **Fixed (sc-17-ask-fixes).** `askDigest` takes a `canTake(chatId)` and addresses the check to the first quiet ask's chat that can (open, idle, still this first mate's); the hook passes it. The message still names every quiet ask, and goes to the chat chosen even if an ask settles while the app CLI's command is being fetched. When no quiet ask's chat can take it, nothing is sent or marked, so the next pass tries again. The trace test was flipped. Not covered: a first mate whose chats are all gone (reset removes the old one) still gets no check, which is D1/A7 territory. |
| **A6** [T] | medium | A lone short ask is never written to Ledger A (`worthKeeping`). The reply is its only record. The spec says "nothing Ash asks can be lost". Ledger B does record it. | **Fixed (sc-18-one-ask-ledger).** Every ask the quick reading holds is written; `worthKeeping` (unchanged, on the rules' own reading) now decides only whether the chat shows it. When it says no, the row is `quiet`: on the Chief's list, no receipt under the message (`AskReceipt` returns nothing for an all-quiet message), not owed, not nudged, not in `<open_asks>`, not in the daily check, until someone moves it (its history then grows past one step). `askEval.test.ts` ("a short single ask is written down quietly, by both") was flipped from "not written at all". |
| **A7** [R] | high | No path from a Ledger A ask to the person except the passive receipt (red "waiting on you"). Nothing in `needs/`, `home/`, `inbox/`, `chief/` or `orchestration/` imports it (grep). The spec's "after two nudges, in red, in Needs you" is not built. Both nudges and the daily check go to the **first mate only**, so a first mate that ignores them leaves the ask `heard` or `started` forever. | **Fixed (sc-20-quiet-ask).** The daily check counts, per ask, how many times it found the ask open with nothing moved (`Ask.chase`, `askQuiet.ts withDailyCheck`); the second raises it as one Needs you row (`raisedAsks`, `needs/model/quietAsks.ts`, kind `ask`): "You asked: <its words>", "Still open since <weekday or date>. <first mate> hasn't moved it." (for an ask waiting on the person: "<first mate> is waiting on you."). Raised once per quiet spell: any change to the ask (`updatedAt` moves) ends the count and the row. The card's answers: Answer it (the chat, on the message), Let it go (the person's own drop, compare-and-swap on the row drawn), Remind <first mate> (one app message, queued in the ledger and sent by `useAskLedger`; the count starts again, so the ask returns after two more quiet checks). A message from Ash in the chat, or the card's box, answers it too. Tests: `askQuiet.test.ts`, `useAskLedger.quiet.test.ts`, `quietAsks.test.ts`, `needsLive.quietAsk.test.ts`, `NeedDetail.quietAsk.test.tsx`, `tests/browser/quiet-ask.spec.ts`. **Not covered:** waiting asks are counted by this rule but the model's `stuck` leaves them out; a raised ask whose first mate was removed has no Remind; the count moves when a check is marked, even if its message could not be sent; a Remind into a chat the app host drops silently (as the daily check can) is cleared as sent. |
| **A8** [R] | low | Closed rows past 2000 and "heard" marks past 4000 are evicted oldest first. A message whose mark is evicted is re-heard and a `done` ask is created again as `heard`. Spec: "rows are never deleted". | Keep a tombstone, or do not re-hear a message older than the ledger's last eviction. |
| **A9** [E] | medium | Two failed model tries are final. A provider outage during a rant leaves 33% of the asks (A.2); no timer, no third try. | Retry on a timer, and tell the person when only the rules read it. |
| **A10** [R] | info | Asks in a worker, room or plain chat are never heard (`askMate.ts`, by design). | State it on the receipt. |

**Ledger B: hub ledger and the dump check**

| | Sev | Gap and minimal trace | Do |
| --- | --- | --- | --- |
| **H1** [T] | high | `writeLedger` keeps the newest 400 rows, open or not. Trace: 401 asks said, none settled → the first is gone, never closed (`askLedger.gaps.test.ts`). At 6 asks a message that is about 67 messages. | **Fixed (sc-17-ask-fixes), and moot since sc-18.** `writeLedger` kept every row up to 400 and never an open row past it. That ledger is gone; the one ledger caps only closed rows (2000, oldest first, `askDocForDisk`) and never an open one. `askLedger.gaps.test.ts` now runs the same trace on it (401 hub asks all kept; past the closed cap the oldest closed go and every open one stays). |
| **H2** [T] | medium | `extractAsks` stops at 6 per message. A message with 8 asks writes 6; the last two are never recorded. | **Fixed on the combined path (sc-18).** The regex still stops at 6 (pinned), but the path that feeds the ledger (`wideAsks`) has no cap: 8 asks are 8 rows (`askLedger.gaps.test.ts`, `wideReading.test.ts`). |
| **H3** [T] | medium | A look that throws or times out is turned into `""`, which `parseMissed` reads as "nothing missed"; the note is forgotten and the dump is claimed, so it is never looked at again. Trace: first look throws → `offer` not called, notes empty → a later look that would find a gap is never run. (Rule: a timeout is not a final failure.) | Treat a failed look as "try again": do not forget the note or claim the dump. |
| **H4** [M] | medium | A held done-claim check is persisted as "held" before it is delivered; a restart before delivery drops the in-memory check and the persisted flags block making it again. | Persist the check itself, or clear the flag at startup. |
| **H5** [T] | medium | **Two ledgers disagree.** The Chief's "You asked" chip reads Ledger B (`open handled parked dropped`); first mates write Ledger A (`started waiting done…`). The person's list never shows the states a first mate sets. | **Fixed (sc-18-one-ask-ledger), the two-ledger finding.** The chip, the open-asks line on a check card, the dump check's look and the settle all read Ledger A through `askedView.ts`; Ledger B's writer is gone (`dumpCheck.noteDumps` hands a hub chat's dump to `hubRoute.ts`), its open rows were moved in once (`askMove.ts`, tested), its key is read-only for one release. The list now shows Working, Waiting on you (red) and what a finished job proved. `askedView.test.ts` pins that the list shows the same rows, words, notes and counts as before for asks both ledgers held. |
| **H6** [M] | low | Ledger B has no compare-and-swap: two windows can overwrite each other. | **Gone with Ledger B (sc-18).** Every ask write is now the revision-checked document store's. |

**Jobs: handing work down**

| | Sev | Gap and trace | Do |
| --- | --- | --- | --- |
| **D1** [R] | high | **Resetting a first mate orphans the reports of its running workers.** `resetMonoSession` removes the old chat and sets a new session id (`monoWorkspace.ts:213-243`); the running rows still name the old chat as `ownerSession`; a finished worker's report goes to `queueMonoSessionCompletion(oldId)`, which returns silently when the id is no longer a first mate chat (`App.tsx:11208`); at the next launch boot recovery cancels and disposes the row ("owner is gone", **[M]**). The ask stays `started`, with nobody to tell. (The reset and the silent return read by me; the whole path not run.) | **Fixed (sc-19-reset-reparent).** When a chat that owns open work is reset, archived or deleted, that work moves to the chat that takes its place, in one database transaction (`delegations/reparent.rs`, `reparent`): every row that is running, asking a question, or finished with its report not yet delivered, and every job waiting for a free worker, with a log line on each row ("Moved from <chat> after a reset"). A reset hands the work to the fresh chat; an archived or deleted chat's goes to the same first mate's main chat, or, for a deleted chat whose first mate is gone, to its project's Lead's main chat. Rows delivered, read, discarded or cancelled stay where they ran. The new chat gets one app note listing what moved. Reports and questions that arrive later go to the new chat; a report in flight to the old chat is queued to the new one once (the move is compare-and-swap on the row's owner, and the batch cache's "mark queued, then queue" is one step in the tracker's line, so a move falls before it or after it, never between). Nothing is cancelled or restarted. Not covered: the first mate's own main chat deleted while it is its project's Lead (no chat can take the work), and a quit in the instant between the old chat's removal and the move (boot recovery then reports those rows cancelled, as before). |
| **D2** [M] | high | A quit between a worker turn's end and `settle` lets boot finish the worker from its transcript with no gates or landing (`delegations.ts:448-460,1006-1012`). The gate verdict may read Done with no gate run. | Run the gates on boot settle, or mark it unsure. |
| **D3** [M] | medium | `report()` marks a row `queued` before the host call; the host returns silently if the owner chat is closed (`App.tsx:11208-11214`). No retry until the next launch. | Mark queued only after the host accepts it. |
| **D4** [M] | medium | A worker held for a usage limit stays `running`, so it reads "Working" until Ash acts or the app restarts (`App.tsx:14993-15006`). | Show it as Waiting with the reset time. |
| **D5** [T] | medium | A job's end is not linked to its ask (0.4). | **Fixed (sc-18-one-ask-ledger).** A delegation's `asks` takes ledger ids (the `id` of each ask in `asks.list`; every open-asks line now shows it), the old `a_...` ids still pass; `useAskJobs` applies the rows to the ledger: started while it works, done with its gate verdict and report summary when it passed and was accepted, back to heard with a note when it failed or was cancelled. Tests: `askJobs.test.ts`, the model-based property test (job steps), `useAskLedger.oneLedger.test.ts`, `agentAppTasks.test.ts`, and `delegations.rs`. **Not covered:** a PR watch's `asks` (still `a_...` only), and a job whose row has left the recent list before the app saw it end. |
| **D6** [M] | medium | A failed row leaves every list after 6 h (`FAILED_RECENT_MS`); grey failures never reach Needs. | Keep a failed job a Need until someone closes it. |
| **D7** [M] | low | `promiseNudge` goes silent after 2; its comment says "Ash should see it", no consumer exists. | As A7. |
| **D8** [M] | medium | Orchestration runs are a second worker ledger that Needs and the Chief do not read. | Surface paused runs. |

**Needs you: surfacing**

| | Sev | Gap and trace | Do |
| --- | --- | --- | --- |
| **N1** [R] | medium | The one-tap answer on a decision card sends no `by`: `needsLive.ts:289-296` → `tauriFirstMate.answer(project, key, option)` → `steering.ts:138` forwards `by: undefined` → `decisions.rs:1785-1792` returns "Say who is answering.". Read, not run. (The mapper adds that the tests mock the call as always applied and that the Inbox panel passes `by` and works: **[M]**.) | Pass `by: "user"` from the one-tap, and test against the real command. |
| **N2** [M] | high if hit | An answer is committed with its delivery rows; if the waiting chat can't be read at delivery (`.catch(() => null)`) the delivery fails permanently on the first try and nothing re-releases it or tells the person. | Retry a failed delivery; surface a failed one. |
| **N3** [M] | medium | A worker with 20 pending steering messages makes `record` fail, which rolls back the person's answer to every decision it waits on. | Queue past the cap or fail only that delivery. |
| **N4** [M] | low | Set-aside gives up silently after 5 write conflicts; `needsCount` and the badge can differ. | — |

### B.4 What is modelled, and what is not

| Modelled (Quint `asks.qnt`, or the property test on the real store) | Not modelled |
| --- | --- |
| Ledger A's statuses and who may move them; replacement on a re-hearing; the maybe cap; hand-added asks; the nudge cap; `open_asks` injection; compaction; restart; two windows (property test) | **Extraction** (that is part A); the text of a message; `covers`'s 60% rule (the property test passes lists in directly) |
| One job per ask; finished or failed; the report and an orphaning reset | Gates, landing, stalls, usage-limit holds, the boot sweep, auto-resume counts, `follow` rows, retries across generations |
| The person's taps and an open or closed chat | Ledger B and Needs/decisions state machines (mapped in 0, gaps H and N listed, not modelled) |
| Time as days, for the bounded liveness | Real time; the 20 h and 24 h and 3 day thresholds are not modelled as numbers |
| | Several first mates, several chats, several messages, the closed cap and heard cap (A8, tested nowhere) |

`asks.qnt` has no two-ledger split (it models Ledger A alone), so sc-18 left it as it was. It models a first mate marking an ask
started or done by hand; the app's own automatic end (a job's end updating its ask) is covered by the TypeScript model-based test
above, not by Quint.

### B.5 Ways this could be wrong

- `asks.qnt` has not been through the Quint typechecker or simulator **since sc-20-quiet-ask turned `ESCALATE` on** (it was run on 13 Nov 2026 before that). Treat its "expected" results for the default file as hypotheses until the commands in B.1 are run.
- Gaps tagged **[M]** come from read-only subagents and were not re-checked by me; each was asked to try to refute it before
  reporting, but a few are marked conditional by them. The Rust side was not built or run.
- No app was started. The hook was rendered in happy-dom, not in the Tauri webview.
- The map reads the code at `bff595380` (branch `sc/15-asks-formal`, off `main`).
