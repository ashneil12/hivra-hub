# Hub frontend: handoff notes for Claude Code

All hub data comes through `model/hubData.ts` (`setHubDataSource`) and the
per-page stores in `model/` (mock data, labelled "Example:").

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
