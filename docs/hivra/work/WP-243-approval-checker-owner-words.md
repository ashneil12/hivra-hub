# WP-243: The approval checker reads only Ash's words, and a yes runs that exact action once

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | L | WP-14, WP-146 | no (security) |

## Goal

When an agent wants to act for Ash, the app decides from what Ash himself said, never from tool output or memory. A
"Needs you" card shows the exact action. A yes runs only that action, only once.

## Why

- Nod (Apache-2.0, `src/server/trust-basis.ts` `trustDecision`, `approvals.ts`):
  - the checker sees only the owner's messages, routine instructions and rules;
  - it must name which one covers the action, and the server copies the quote itself;
  - the question is written from a frozen copy of the action and fact-checked by a second call;
  - a yes runs that exact payload once, and a correction closes the old waiting approval.
- nightly-labs OpenBot and Nod both mark an interrupted step "uncertain" and never replay it.

## Build

1. Freeze the action: tool name plus full arguments, hashed. The card shows it, and a yes binds to that hash. A
   retry with different arguments asks again.
2. Covered-by check: given only Ash's messages in this chat, his standing rules and the routine's instructions,
   the cheap tier answers "covered by #N", "a rule" or "not covered". The app checks that the quoted words appear
   in the source it named. "Not covered" asks Ash, with "Because you said '...'" shown when it is covered.
3. A turn Ash stopped, or one the provider failed, is "withdrawn". Its words stop counting for approvals and
   memory, but it stays visible.
4. An interrupted tool call is recorded as uncertain and never replayed on resume. The resume note names it.

## Done when

- [ ] Tests:
  - a hash mismatch asks again;
  - a quote that isn't in the named source is refused;
  - a withdrawn turn doesn't cover an action;
  - an uncertain step is not replayed.
- [ ] Full security review (this is a security package).

## Built (11 Nov)

- **A yes runs that exact action, once** (`sessions/model/approvalAction.ts`). The action hash is a SHA-256 of the tool
  name plus the full arguments, as canonical JSON. `claude.ts` hashes a frozen copy of the input when it asks, answers
  an allow with that same copy, and turns an allow into a deny if the copy's hash changed. Every other CLI is hashed
  from what it showed. The registry keeps a ledger of the calls still waiting, keyed by chat and request id.
  `respondHarnessApproval` refuses an allow that names no hash, a hash that doesn't match the waiting call (a retry
  under a reused id asks again), or a call nobody is waiting on (fail closed). The ledger forgets a call once it is
  answered, so a second yes runs nothing. A deny needs no hash. Every allow path passes the card's hash: the card,
  Autopilot, the phone, the orchestration host and the Mono relay. A relayed card whose allow wasn't sent now settles
  as cancelled, not allowed. An open card shows the exact command in full (`data-approval-exact`).
- **Covered by Ash's words** (`autopilot/model/ownerWords.ts`, adapted from Nod's `trustBasis`, with credits and
  NOTICE; `autopilot/hooks/useOwnerWords.ts`). It covers only Ash's own chats: never a worker, a delegated chat or a
  hidden chat other than a routine's run. It covers only a Bash command shown whole with a frozen hash, and never a
  subagent's ask. The hold rules come first and skip the model entirely: the red list, unreadable shell words,
  credential paths, and Row-Bot's always-ask actions (send, delete, pay, publish, account, commit, forceful).
  The question holds only:
  - Ash's typed messages (`byOwner`; never an app note, a brief, a draft, a tool result or memory; withdrawn turns
    left out);
  - his standing answers;
  - the routine's prompt.

  Each source is fenced and escaped, and the action is passed as data. The answer must name one source and quote
  it. The app then checks:
  - the quote is in that source (loose on case, quotes and spacing);
  - it is at least 8 characters and 2 words;
  - it shares a word stem with the command.

  Only then does the app allow, bound to the hash, and the card says "Allowed because you said "..."". Anything
  else asks Ash, exactly as before: no cheap model, an error, an unreadable answer, or a quote it can't find.
- **Withdrawn turns** (`sessions/model/withdrawnTurn.ts`). Stopping a chat marks the running turn's message and its
  steers `withdrawn: "stopped"`. A turn ended by a provider error notice counts as withdrawn too. The words stay
  visible but don't count for the covered-by check.
- **Uncertain calls** (`inFlight.ts`). On a quit, crash or ship, a call that was running, or allowed and not yet
  back, is sealed as cancelled with `uncertain: true`. The card says so. The resume note lists each one by command and
  id, and says it was not run again and must not be repeated as it was. A call still waiting on Ash, or refused,
  isn't uncertain.
- Tests:
  - `approvalBinding.test.ts`
  - `ownerWords.test.ts`
  - `useOwnerWords.test.ts`
  - `withdrawnTurn.test.ts`
  - `inFlight.uncertain.test.ts`
  - the browser spec `tests/browser/wp243-approval.spec.ts`

  The shots are in `shots/wp-243/`.
- Left open:
  - Nod's second fact-check call isn't built. The app's own quote check stands in for it.
  - The check runs only when Settings > Memory picks a cheap model. The default tier asks Ash every time.
  - Only Bash commands are covered.
  - A routine's prompt counts as its words even when the captain wrote it.
  - Memory doesn't read the withdrawn mark yet.
  - Blocks imported or teleported with `byOwner` keep it.
  - The quick composer and Mono steers aren't marked `byOwner`, so they never cover anything.
  - A standing answer can quote option text an agent wrote and Ash ticked.
  - A chat in full access never asks, so none of this applies there.
  - No Rust was changed. The Claude CLI answers an allow with `updatedInput`, and the app sends the frozen copy.
