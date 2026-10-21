# Agent-to-agent notes in a chat (for the app's code; not shipped to agents)

Ash, 21 Oct 20:45: agent-to-agent messages show inline in the chat as small clickable notes, not in a log ("Lead
messaged Worker X", "Worker X messaged Lead", "Worker X got stuck"). Clicking opens that agent's chat if there is one;
with none, the note has no link. When a worker reports, the note links the worker's chat.

Split: CoS owns the data (this event), PM owns the look. `src/features/monos/ui/AgentNoteRow.tsx` is the plain default
render; restyle it freely, keep `data-agent-note` / `data-agent-note-open` or update `agentNotes.test.ts`.

## The event

A system `Block` in the chat that owns the work (the Lead's chat, or whichever chat delegated), with `agentNote`:

```ts
type AgentNote = {
  kind: "messaged" | "stuck" | "reported";
  from: { session: string; name: string };   // chat id + how the note names it ("Lead", 'Worker "Fix the save bug"')
  to:   { session: string; name: string };
  target: string | null;                     // chat the note opens (the worker's), null when that chat doesn't exist
  taskId: string;                            // the delegation row
  at: number;                                // epoch ms
  line?: string;                             // brief's first line, the question, why it's stuck, or the report's first line
};
```

`block.text` is the plain sentence (`agentNoteText`), `block.id` is stable per move (`agentNoteId`), so a note is
never added twice.

## Where the events come from

`src/features/monos/model/agentNotes.ts`, from the delegation rows the app already keeps (no new plumbing):
- `messaged` owner → worker: `delegate_task` made the row (`createdAt`).
- `messaged` worker → owner: the worker asked its Lead a question (row state `question`).
- `stuck`: the stall watcher marked it stalled, or it failed (`stuckOf`).
- `reported`: the row completed (its report came back), `line` is the result's first line.

`useFollowedBriefs` adds them on its sweep through the same `note(chatId, block)` path as "Still running: N", only for
moves from this run of the app on (older history isn't replayed). Opening calls `delegationActions().openChild(owner,
target)`.
