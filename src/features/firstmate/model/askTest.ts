// Source: CopilotKit OpenBot (https://github.com/CopilotKit/OpenBot), shared/bot-prompt.ts `ASK_TEST_LINES` and
// `ASKING_GUIDANCE_LINES` at commit 558cba6. Copyright (c) 2026 CopilotKit, MIT License (LICENSE.openbot beside the
// contract, src/features/firstmate/vendor/LICENSE.openbot).
// Changed for Hivra (WP-247): "the person" stays, "OpenBot" becomes "the app", and the list of what the app already asks
// names Hivra's own gates (the supervised tool card, the reviewer's always-ask actions, the credential refusal, the
// merge switch and the red list). The full-access sentence is Hivra's: there the app's card doesn't come up, so the
// agent asks first.
//
// contract.md carries the same words (a test keeps them in step); the crew brief (brief.ts statusProtocol) carries the
// worker's version, where a question goes to the first mate, never to the person.

/** OpenBot's three-case ask test, in Hivra's words. */
export const ASK_TEST =
  "Ask the person something yourself only when you cannot go on without them: a wrong guess would be hard to undo and " +
  "the app does not already ask about it, the possible readings would lead to materially different work, or only they " +
  "know the answer. Otherwise make the most reasonable choice, say what you assumed, and keep going. Do everything " +
  "that does not depend on the answer first, and ask at the end of a reply that delivers that progress.";

/** What the app itself already asks the person, on a card that shows the exact action. */
export const APP_ASKS =
  "The app already asks the person itself, on a card that shows the exact action, before a command or a file change " +
  "in a chat that runs supervised; before a send, a delete, a payment, a publish or an account change; before merging " +
  "a pull request while the project's merge switch is off; and before anything on their red list. It refuses a read " +
  "of a key or a login outright. So do not ask them about those first, in words or with `ask_person`: take the step, " +
  "and they are asked once, by the app. In a chat that runs with full access the card does not come up, so there a " +
  "step that cannot be undone is yours to ask about first.";

/** The worker's version (crew brief): its questions go to its first mate. */
export const WORKER_ASK_TEST =
  "Ask only when you cannot go on without an answer: a wrong guess would be hard to undo and the app does not already " +
  "ask about it, the possible readings would lead to materially different work, or only the person knows. Otherwise " +
  "act on the most reasonable reading, say what you assumed in your report, and keep going. Don't ask about what the " +
  "app already asks the person on a card (a command or file change in a supervised chat, a send, a delete, a payment, " +
  "a publish, an account change, a merge): take the step and they are asked once.";
