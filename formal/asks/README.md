# Asks: can "a long rant never loses an ask" be checked?

A research spike. It changes no product behaviour: everything here is under `formal/asks/` plus new test files. Bugs
found are documented with a minimal trace and pinned by a test; none is fixed.

**Status, up front**

| Part | State |
| --- | --- |
| Step 0, the map (below) | Done. Each claim is tagged: **[T]** pinned by a test in this PR, **[E]** measured by the eval run, **[R]** read by me in the code, **[M]** reported by a read-only mapper and not re-checked by me. |
| A. Extraction eval (`eval/`) | Done and run (`node formal/asks/eval/run.mjs`). The "recorded" model replies are **simulated**, not captured from the app's engine (see A.3). |
| B.2 fast-check model-based test | Done and run against the real store. Passes; bites on two deliberately broken reducers (B.2). |
| B.1 Quint model (`asks.qnt`) | **Written, not typechecked, not run.** `npx @informalsystems/quint` needs an approval that was not available in the session that wrote this. The file was desk-checked only. Run the commands in B.1 before relying on it. Apalache: not tried. |

## Run it

```bash
node formal/asks/eval/run.mjs                      # extraction recall, offline (the saved output is eval/REPORT.md)
npx vitest run src/features/asks/testbed/askEval.test.ts src/features/asks/model/askStore.property.test.ts \
  src/features/asks/model/asks.gaps.test.ts src/features/asks/hooks/useAskLedger.gaps.test.ts src/features/hub/model/askLedger.gaps.test.ts
npx @informalsystems/quint typecheck formal/asks/asks.qnt                       # not run yet, see B.1
npx @informalsystems/quint run --max-samples 20000 --invariant inv_touchedNeverGone formal/asks/asks.qnt
```

---

## 0. The map

### 0.1 Four different things are called "ask"

| Name | Where | Holds | Fed by |
| --- | --- | --- | --- |
| **Ledger A**, the first-mate ask ledger | `src/features/asks/model/{asks,askStore,askNotes}.ts`, `hooks/useAskLedger.ts`, `ui/AskReceipt.tsx`; one document `asks` in the local hub database (`src-tauri/src/local_hub.rs`) | Ash's asks to a first mate, with statuses `heard maybe started waiting done dropped` | `useAskLedger` (rules + model reading), Ash's "Add one that was missed", the first mate's `asks.update` |
| **Ledger B**, the hub ask ledger | `src/features/hub/model/{askLedger,askSettle,dumpCheck}.ts`; `localStorage` key `monocode:hub-ask-ledger` | Asks in a hub chat, statuses `open handled parked dropped`; read by the Chief's "You asked" chip (`features/asks/ui/ChiefGlance.tsx:15-28`) | `dumpCheck.noteDumps` → `recordAskText` → `extractAsks` (regex only) |
| **Jobs** (delegations) | `src/features/monos/model/delegations.ts`, `src-tauri/src/delegations.rs`, `firstmate/status.rs` | Work handed Chief → first mate → crew. Status `working paused needs-you done failed` | `tasks.delegate`, `captain.handoff` |
| **Decisions / Needs you** | `src/features/needs/**`, `src-tauri/src/decisions.rs` | Questions and approvals waiting on the person | `decisions_ask`, stuck workers, gates, tasks, PR watches |

Not asks: `src/features/inbox/model/inboxAsk.ts` is the prompt for asking a question about a GitHub or Linear inbox
item **[R]**. The `asks: ["a_..."]` field on a delegation and on a PR watch carries ids from the retired Ash OS (see gap D5).

The spec for Ledger A is `docs/specs/mono-chat-memory.md` section 6 ("nothing Ash asks can be lost"). Ledger B predates it.
**Nothing connects A, B, jobs and Needs.** That is the main finding of this map.

### 0.2 Where an ask is born

**Ledger A** (`useAskLedger.ts`, main window of the Hub bundle only), for each of Ash's messages to a first mate (`askMate.ts`:
a first mate's own chats and a coding team's chat with its lead; never a room, a worker or a plain chat) **[R]**:

1. Skip a message from before the ledger began (`doc.since`), a draft, an app note (`[MonoCode ` prefix), a slash command, a
   bare "ok" or "thanks" (`asks.ts nothingToHear`).
2. **Quick reading at once** (`asks.ts rulesAsks`): split into sentences; a sentence is an ask if it matches a signal list
   (`can you`, `please`, `make sure`, `I want`, `we should`, a question mark, a leading verb from a fixed list). One short
   message is one ask taken whole.
3. **Written only if worth keeping** (`useAskLedger.ts worthKeeping`): two or more asks, or one ask in a long message
   (200+ characters or 3+ sentences). **One short ask is never written down** (gap A6).
4. **Model reading** for a long message, in the background (`isolatedCompaction`, a Claude text call with a 180 s limit,
   `app/hooks/useMonoTrees.ts:26`): `hearPrompt` asks for a JSON list of `{quote, summary, kind}`. `parseHeard` keeps an item only
   if its quote is in the message word for word (so the model cannot invent an ask). At most `MODEL_TRIES = 2` tries; the
   second waits until the chat is idle. Each try, good or bad, is counted.
5. **Safety net** (`hearMessage`): any sentence the rules read as an ask that no model quote covers (60% word overlap) is added
   as a `maybe`, at most 6 per message.
6. **Replacement** (`withHeard`): hearing a message again replaces that message's rows nobody has touched with the new
   list (new row ids, new numbers). A row with a status, a note, or Ash's hand on it is kept.

**Ledger B**: `lookAtDumps` → `noteDumps` records every "dump" message (any ask, 280+ characters, or 3+ lines) and calls
`recordAskText` → `extractAsks` (regex only, no model, **6 per message**, `askLedger.ts:47`) **[R]**. A separate isolated
"look" later compares each dump with the reply and the build (`dumpCheck.ts lookAtDumps`).

### 0.3 Where an ask is stored

| | Store | Concurrency | Caps |
| --- | --- | --- | --- |
| Ledger A | `hub_local_docs` document `asks` through `askStore.ts` | Revision compare-and-swap; 5 tries; one write queue per window; `local-hub://changed` makes other windows re-read (`askStore.ts:76-102`) **[R]** | closed rows 2000 (oldest out), "heard" marks 4000, history 20 steps (`asks.ts:66-77`). Open rows are never capped. |
| Ledger B | `localStorage`, whole array rewritten | Read-modify-write, **no** compare-and-swap **[R]** | **newest 400 rows, open or not** (`askLedger.ts:46,172`) |
| Jobs | SQLite `delegations` (`src-tauri/src/delegations.rs:71`) | one connection | log 50 lines; none for rows |
| Decisions | SQLite `decisions`, steering rows | `Immediate` transactions; stale answers get `applied: false` | open list 200 **[M]** |

### 0.4 Handed Chief of Staff → first mate → crew

- The Chief files a task then calls `tasks.delegate` to a project's lead (`captain.handoff`, `agent-app/model/agentApp.ts:1928-1975`)
  **[M]**. The Chief never starts crew itself. "Working" on its screen is a view over every delegation row.
- A first mate (or a coding-team lead) calls `tasks.delegate` for a worker; the row gets `ownerSession` = that chat, a child
  session `app-<caller>-<request>`, and the `askIds` field **[M]**.
- A worker's end is queued to the owner chat as a message (`queueMonoSessionCompletion`, `App.tsx:11201`); the row is the truth
  (`delegations.ts:1-10`), the queued message is saved with the session **[R][M]**.
- **There is no link from a job to a Ledger A row.** The `askIds` field accepts only `a_...` ids (`agentAppTasks.ts:619-630`)
  and Ledger A ids are `ask-<n>-<block>` (`asks.ts:341`). So after a job ends, the ask stays `started` until the first mate
  remembers to call `asks.update` (gap D5). **[R][M]**
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
| any but `dropped` → `started` | `asks.update` | first mate |
| `heard`/`started` → `waiting` (needs a note) | `asks.update` | first mate |
| any → `done` (first mate needs a non-empty proof string) | `asks.update`; "Mark done" | first mate, person |
| any → `dropped` | "Drop this ask", "Not an ask" | **person only** (`changeProblem` refuses the first mate) |
| `maybe` → `heard` | "Yes, this is an ask" | person |
| `done`/`dropped` → `heard` | "Reopen" | person (the first mate cannot revive `dropped`) |
| closed → evicted | more than 2000 closed rows, oldest first (`askDocForDisk`) | app |
| told | turn-end nudge: an app message naming still-`heard` asks, at most twice since Ash's last message, only into an idle chat whose last block is a reply (`askNotes.ts askNudge`) | app |
| told | daily check: one app message naming asks `heard` for 24 h or `started` and quiet for 3 days, at most every 20 h, **addressed to the chat of the oldest such ask** (`askDigest`; hook `useAskLedger.ts:174-196`) | app |

**Ledger B** (`askLedger.ts`, `askSettle.ts`, `dumpCheck.ts`) **[R]**: new → `open`; `open` → `open` (said again: `said + 1`, words
replaced); `handled` → `open` (said again); `open` → `handled` (a "Right" answer, a "Fixed" the build covers, or a done claim the
build covers, `settleAsks`; or a look that found nothing missed and the build covers it); a row is evicted at 400.
`parked` and `dropped` exist but **no non-test code sets them** (`parkAsk`, `dropAsk` and `reopenAsk` have no callers, by grep).

**Jobs** **[M]**: `state` `running → question ⇄ running → completed | failed | cancelled`; `delivery`
`pending → queued → delivered → acknowledged | disposed`; shown status `working paused needs-you done failed` derived in Rust
(`firstmate/status.rs:193-292`). A cancel sets `disposed`. A failed or cancelled row can go back to `running` with a new generation.

**Decisions** **[M]**: `open → answered` (`answer_both`, which also releases the waiting workers' steering rows in one
transaction), `retire`, a standing-answer flag. No expiry or supersede. "Set aside" is client-side, 24 h.

### 0.6 The six scenarios

| | Ledger A | Ledger B | Jobs | Needs / decisions |
| --- | --- | --- | --- | --- |
| **App restart** | Rows persist. The hook re-hears any message with no "heard" mark (`since` rule); an in-flight reading is lost and redone. **[R]** | Rows and dump notes persist; a check claimed but not yet delivered is lost (H4). **[M]** | Rows persist; boot recovery in one window: drop/cancel/settle, re-queue unreported (`delegations.ts:437-473,952-991`). A cut worker is settled from its transcript with no gates (D2). **[M]** | Rows and steering rows persist and are drained at start. **[M]** |
| **Retry** | Two model tries; a failed try is counted and the rules' reading stands; a repeat of one message replaces untouched rows (A1-A4). **[R][T]** | A repeat lands on the same row; a failed look is **not** retried (H3). **[T]** | Auto-resume of a cut turn: 3 times, then a "resume stopped" note (`inFlight.ts:26`). **[M]** | Steering delivery: 5 tries, every 30 s. **[M]** |
| **History compaction** | The ledger is untouched. A fresh session always gets the `<open_asks>` note; the state card (`stateCard.ts`) lists rules, decisions and finished asks, not open ones. **[R]** | Not involved. | The tidy brief keeps exchanges only: no open-job content. Queued reports go into the fresh session. **[M]** | — |
| **Cancellation** | Only the person can drop. A retraction in the same message ("scratch that") is not detected by either extractor (A.2: withdrawn asks stay open). **[T]** | `dropAsk`/`parkAsk` never called. | Owner Stop, `task_cancel`, trashing a mate cancel and dispose the row. **Resetting** a first mate orphans its running rows (D1). **[R][M]** | Nothing cancels a decision. |
| **Worker crashes** | Nothing is written. The ask stays `started` until the first mate acts; the daily check names it after 3 quiet days but only into the right open chat (A5). **[T]** | `askSettle` compares the chat's build with the ask, so a crash leaves it open. | The turn settles `failed` and a failed report is queued to the owner. A failed row leaves every list after 6 h (D6). **[M]** | A stuck worker becomes a Need only if it needs Ash; otherwise grey and gone after 6 h. **[M]** |
| **First mate's turn is cut** | Auto-resume (≤ 3); the resumed turn gets the `<open_asks>` note again if the list changed. **[R]** | — | Its rows are untouched; queued reports survive in the session queue. **[M]** | — |

### 0.7 What the spec promises, and what the code does

`docs/specs/mono-chat-memory.md` §6, line numbers from `:412-496`.

| Promise | Code |
| --- | --- |
| "Rows are never deleted" (`history` row) | **No.** Untouched rows are replaced on a re-hearing (A1, A2); closed rows past 2000 are evicted. |
| "Quotes are checked, not trusted" | Yes (`parseHeard` → `quoteIn`). |
| No-model backstop adds uncovered sentences as `unclear` | Partly: at most 6, and "covered" is a 60% word-overlap guess. |
| "Short messages skip the model. One sentence is one ask" | The ask is taken whole, then **not written** unless the message is long or holds 2+ asks (A6). |
| "A repeat joins, not doubles… attached as a second quote" | It bumps `updatedAt`; no second quote is kept. |
| Turn-end check "at most twice. After that the asks stay open, in red, in **Needs you**" | The nudge and its cap are enforced. **The Needs part is not**: nothing under `needs/`, `home/`, `inbox/`, `chief/` or `orchestration/` imports Ledger A (grep) (A7). |
| "Done needs proof… a link the app can check exists" | A non-empty string. |
| "Dropped is Ash's word" | Yes, stricter: the first mate can never drop. |
| "Open asks are always in front of the Mono… at every session start" | Yes for first mates (`openAsksNote`). |
| "A checker at the end… the open asks for that job go to the done checks" | Not found: no link from a job to a ledger row (D5). |

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
| **hub** extractor (Ledger B, regex, 6 per message) | 62% (32) | 62% | 11, and 9 merged into another ask's row | 4/7 | 2/5 | 1 |
| **rules only** (Ledger A, no model) | 33% (17) | 33% | 27, and 8 merged | 0/7 | 1/5 | 1 |
| **oracle** (a model returning exactly the labels) | 100% (52) | 100% | 0 | 7/7 | 5/5 | 0 |
| **recorded** (simulated typical model) | 92% (48) | 92% | 4 | 4/7 | 5/5 | **3** |
| recorded, model names only its first 2 asks | 35% (18) | 58% | 22 | 3/7 | 0/5 | 2 |
| recorded, first call per message times out | 92% (48) | 92% | 4 | 4/7 | 5/5 | 3 |
| recorded, **both** calls time out | 33% (17) | 33% | 27 | 0/7 | 1/5 | 1 |

What it says:

- **The pipeline is sound when the model is good**: the oracle run loses nothing (also asserted in the test).
- **With no working model the ledger holds a third of the asks.** Two failed tries are final (no timer, no third try), so a
  provider outage during a rant leaves Ledger A at 33%. The hub extractor does better (62%) because its regex is broader, but it
  stops at 6 per message and merges a one-sentence run-on into one row.
- **The safety net helps**: when the model names only 2 asks, "maybe" lines raise recall from 35% to 58%.
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

### B.1 The Quint model (`asks.qnt`): written, **not run**

Three actors (person, first mate with its crew, app) on one message with three asks (slot 3 is one both extractors miss). It
follows 0.5: rows `heard maybe started waiting done dropped`, replacement on a re-hearing, the maybe cap, the turn-end nudge,
`open_asks` injection, delegation and its report, a worker finishing, a reset that orphans a job, an app restart, a compaction,
time passing, and the person's taps. Knobs at the top say "as the code is today" or "as the spec promises".

```bash
npx @informalsystems/quint typecheck formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_known             formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_touchedNeverGone  formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_dropIsPersons     formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_neverGone         formal/asks/asks.qnt
npx @informalsystems/quint run --max-samples 20000 --invariant inv_noStarvation      formal/asks/asks.qnt
npx @informalsystems/quint verify --invariant inv_neverGone formal/asks/asks.qnt      # Apalache and Java
```

**What I expect, worked out by hand and NOT confirmed by a run:**

| Invariant | Code as it is (default) | Shortest trace I expect |
| --- | --- | --- |
| `inv_known` (exactly one known state) | holds | |
| `inv_touchedNeverGone` (an acted-on ask is never lost) | holds | |
| `inv_dropIsPersons` (only the person drops) | holds | |
| `inv_neverGone` (an extracted ask never disappears) | **fails** | `extract(1), extract(2), rehear(1,omit), rehear(2,omit)`: the second maybe is over the cap (A2). Or `extract(1), handAdd(3), rehear(3,omit)` (A1). |
| `inv_noStarvation` (bounded liveness) | **fails** | `extract(1), tick ×4`: an open ask is shown to the person nowhere but the receipt. |

Liveness, "every ask eventually reaches resolved or surfaced", is checked in its bounded form (`inv_noStarvation`): no heard or
started ask sits un-surfaced more than 3 days. The **fairness** is in `tick`: with `ESCALATE` on, a day cannot pass while an
escalation is due, which is how you say an action is weakly fair for an invariant checker. The first mate and the person are
**not** assumed fair: the first mate is a model that may ignore a nudge, and Ash may not look. Under that assumption nothing in the
code today surfaces a stuck ask (the daily check goes to the first mate only), which is why this fails.

Variants (copy to a temp folder with the same file name, then run the invariants above):

```bash
mkdir -p /tmp/asks-design && sed -e 's/HAND_ASK_REPLACED = true/HAND_ASK_REPLACED = false/' -e 's/MAYBE_CAP = 1/MAYBE_CAP = 9/' \
  -e 's/ESCALATE = false/ESCALATE = true/' formal/asks/asks.qnt > /tmp/asks-design/asks.qnt         # the design: expect all five to hold
mkdir -p /tmp/asks-bad1 && sed 's/MATE_CAN_DROP = false/MATE_CAN_DROP = true/' formal/asks/asks.qnt > /tmp/asks-bad1/asks.qnt            # expect inv_dropIsPersons to fail
mkdir -p /tmp/asks-bad2 && sed 's/RESTART_LOSES_WAITING = false/RESTART_LOSES_WAITING = true/' formal/asks/asks.qnt > /tmp/asks-bad2/asks.qnt  # expect inv_touchedNeverGone to fail
```

The two `bad` variants exist so each invariant is known to bite. They have **not** been run. The TypeScript test in B.2 does show
the same kind of bite on the real code.

### B.2 The fast-check model-based test (`src/features/asks/model/askStore.property.test.ts`): run

Random interleavings (up to 30 steps, 200 runs) of **extract** (rules or model list, any subset, any maybes), **delegate**,
**complete**, **fail** (the first mate marks it waiting), a **worker crash**, the person's **done/drop/reopen/settle**, a first
mate **trying to drop**, an app **restart** (a new store on the same disk), a chat **compaction** (the fresh session must be handed
every open ask), and a **duplicate delivery**, against the **real** `createAskStore` on `memoryDisk()` (two stores on one disk
behave like two windows). A reference model, written from the spec and not from the reducers, runs beside it. After every step:
the store equals the model; every ask is in one known state; ids, numbers and quotes are unique; no ask that was ever touched is
gone; the heard marks match; after a restart the doc is identical; after a crash the daily check names the ask. Two more
properties: two windows hearing one message at once end with one copy of each ask, and two windows changing different asks both land.

Result: `npx vitest run src/features/asks/model/askStore.property.test.ts` passes (4 tests).

**It bites.** I broke the real reducers twice, ran the test, then restored them (`git status` shows `asks.ts` clean):

| Broken reducer | fast-check |
| --- | --- |
| `withHeard`: `untouched = (ask) => ask.blockId === input.blockId` (replace touched rows too) | `Property failed after 25 tests`, seed 929980264. Counterexample `[extract(blk-a, asks=[1], maybes=[], by=rules), delegate(slot 1), duplicate delivery of the last extract]`, shrunk 6 times. |
| `parseAskDoc`: drop `waiting` rows when reading the document | `Property failed after 17 tests`, seed -494838782. Counterexample `[extract(blk-b, asks=[], maybes=[0], by=rules), fail(slot 3)]`, shrunk 3 times. |

A third test pins gap A1: the same machinery with an "add by hand" step. The property that should hold, a hand-added ask survives
every hearing, **fails today**, and the test asserts that it fails and shrinks to `extract, add by hand, extract` (seed 20261113).
When A1 is fixed that test fails: turn it into the plain property.

### B.3 Gaps found, each with its trace and one line on what to do

Tag: **[T]** a test in this PR pins the trace; **[E]** measured by the eval run; **[R]** read by me; **[M]** a read-only mapper reported it, not re-checked.
Severity: *high* = an ask can silently disappear or stay stuck with the person never told.

**Ledger A: first-mate ask ledger**

| | Sev | Gap and minimal trace | Do |
| --- | --- | --- | --- |
| **A1** [T] | high | An ask Ash adds by hand is thrown away when the model's list for its message lands. `withAdded` writes a row with status `heard` and one history step, which `withHeard` counts as untouched. Trace: quick reading writes 3 rows → Ash adds a 4th under the receipt → model list lands → 3 rows (`asks.gaps.test.ts`, `askStore.property.test.ts`). The model call can take up to 180 s, so the window is real. | Count a history step by `ash` as touched. |
| **A2** [T] | high | The model's list replaces the rules' rows; rules asks it did not name are kept only as `maybe`, at most 6 (`MAYBE_PER_MESSAGE`). Trace: 8 asks heard by the rules, a model that names 1 → 1 + 6 rows, one ask gone, nothing says so. | Never let a replacement drop a rules ask: keep all uncovered ones as maybes (cap what is shown, not what is kept). |
| **A3** [T] | medium | A `heard` ask the model's list left out becomes `maybe`, which is not in the `<open_asks>` note and is not "owed" by the turn-end nudge. The first mate stops being told of an ask the rules and the person may both have meant. | Keep it `heard` and add the model's view as a flag, or list maybes to the first mate too. |
| **A4** [T] | low | Numbers change on a re-hearing: "ask 1" from the quick reading is "ask 4" after the model's list lands, and `asks.update {"ask":1}` returns "There is no ask 1." | Keep a row's number when its quote is unchanged. |
| **A5** [T] | high | The daily check is addressed to the chat of the **oldest** quiet ask. If that chat is not open (closed, or reset and removed) the hook skips the whole check and tries again next pass, forever, and nothing is marked sent. Quiet asks in other, open, idle chats of the same first mate are never named either. Trace: asks 1 (chat-old) and 2 (chat-live) 3 days old, only chat-live open → no message (`useAskLedger.gaps.test.ts`, with a control that sends when both are open). | Send to any open chat of that first mate; skip only the asks whose chat is gone. |
| **A6** [R] | medium | A lone short ask is never written to Ledger A (`worthKeeping`). The reply is its only record. The spec says "nothing Ash asks can be lost". Ledger B does record it. | Write it, hide the receipt if one row. |
| **A7** [R] | high | No path from a Ledger A ask to the person except the passive receipt (red "waiting on you"). Nothing in `needs/`, `home/`, `inbox/`, `chief/` or `orchestration/` imports it (grep). The spec's "after two nudges, in red, in Needs you" is not built. Both nudges and the daily check go to the **first mate only**, so a first mate that ignores them leaves the ask `heard` or `started` forever. | Make a quiet ask (after 2 nudges, or a daily check unanswered) a Need. |
| **A8** [R] | low | Closed rows past 2000 and "heard" marks past 4000 are evicted oldest first. A message whose mark is evicted is re-heard and a `done` ask is created again as `heard`. Spec: "rows are never deleted". | Keep a tombstone, or do not re-hear a message older than the ledger's last eviction. |
| **A9** [E] | medium | Two failed model tries are final. A provider outage during a rant leaves 33% of the asks (A.2); no timer, no third try. | Retry on a timer, and tell the person when only the rules read it. |
| **A10** [R] | info | Asks in a worker, room or plain chat are never heard (`askMate.ts`, by design). | State it on the receipt. |

**Ledger B: hub ledger and the dump check**

| | Sev | Gap and minimal trace | Do |
| --- | --- | --- | --- |
| **H1** [T] | high | `writeLedger` keeps the newest 400 rows, open or not. Trace: 401 asks said, none settled → the first is gone, never closed (`askLedger.gaps.test.ts`). At 6 asks a message that is about 67 messages. | Cap closed rows only. |
| **H2** [T] | medium | `extractAsks` stops at 6 per message. A message with 8 asks writes 6; the last two are never recorded. | Keep every ask, or mark the message "more asks than shown". |
| **H3** [T] | medium | A look that throws or times out is turned into `""`, which `parseMissed` reads as "nothing missed"; the note is forgotten and the dump is claimed, so it is never looked at again. Trace: first look throws → `offer` not called, notes empty → a later look that would find a gap is never run. (Rule: a timeout is not a final failure.) | Treat a failed look as "try again": do not forget the note or claim the dump. |
| **H4** [M] | medium | A held done-claim check is persisted as "held" before it is delivered; a restart before delivery drops the in-memory check and the persisted flags block making it again. | Persist the check itself, or clear the flag at startup. |
| **H5** [R] | medium | **Two ledgers disagree.** The Chief's "You asked" chip reads Ledger B (`open handled parked dropped`); first mates write Ledger A (`started waiting done…`). The person's list never shows the states a first mate sets. | Have `ChiefGlance` read Ledger A, or merge them. |
| **H6** [M] | low | Ledger B has no compare-and-swap: two windows can overwrite each other. | Use the same revisioned document store. |

**Jobs: handing work down**

| | Sev | Gap and trace | Do |
| --- | --- | --- | --- |
| **D1** [R] | high | **Resetting a first mate orphans the reports of its running workers.** `resetMonoSession` removes the old chat and sets a new session id (`monoWorkspace.ts:213-243`); the running rows still name the old chat as `ownerSession`; a finished worker's report goes to `queueMonoSessionCompletion(oldId)`, which returns silently when the id is no longer a first mate chat (`App.tsx:11208`); at the next launch boot recovery cancels and disposes the row ("owner is gone", **[M]**). The ask stays `started`, with nobody to tell. (The reset and the silent return read by me; the whole path not run.) | Re-point `ownerSession` when a first mate's chat is reset, or settle with a visible note. |
| **D2** [M] | high | A quit between a worker turn's end and `settle` lets boot finish the worker from its transcript with no gates or landing (`delegations.ts:448-460,1006-1012`). The gate verdict may read Done with no gate run. | Run the gates on boot settle, or mark it unsure. |
| **D3** [M] | medium | `report()` marks a row `queued` before the host call; the host returns silently if the owner chat is closed (`App.tsx:11208-11214`). No retry until the next launch. | Mark queued only after the host accepts it. |
| **D4** [M] | medium | A worker held for a usage limit stays `running`, so it reads "Working" until Ash acts or the app restarts (`App.tsx:14993-15006`). | Show it as Waiting with the reset time. |
| **D5** [R][M] | medium | A job's end is not linked to its ask (0.4). | Give a delegation a `ledgerAsk` number and let its terminal state propose the status change. |
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

### B.5 Ways this could be wrong

- `asks.qnt` has not been through the Quint typechecker or simulator. Treat its "expected" results as hypotheses.
- Gaps tagged **[M]** come from read-only subagents and were not re-checked by me; each was asked to try to refute it before
  reporting, but a few are marked conditional by them. The Rust side was not built or run.
- No app was started. The hook was rendered in happy-dom, not in the Tauri webview.
- The map reads the code at `bff595380` (branch `sc/15-asks-formal`, off `main`).
