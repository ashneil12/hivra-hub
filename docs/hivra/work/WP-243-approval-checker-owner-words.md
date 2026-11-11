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
