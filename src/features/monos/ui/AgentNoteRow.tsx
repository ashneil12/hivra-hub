// The default look of an agent-to-agent note in a chat (model/agentNotes.ts). PM owns the styling; this is the plain
// version: one small muted line. With a chat to open it is a button that opens it (under the chat that owns the work);
// without one it is plain text, never a dead link.
import type { AgentNote } from "../model/agentNotes";
import { agentNoteText } from "../model/agentNotes";
import { delegationActions } from "../model/delegationStore";

export function openAgentNote(note: AgentNote): void {
  if (note.target) delegationActions()?.openChild(note.from.session === note.target ? note.to.session : note.from.session, note.target);
}

export function AgentNoteRow({ note, embedded = false }: { note: AgentNote; embedded?: boolean }) {
  const text = agentNoteText(note);
  const frame = `${embedded ? "" : "px-4"} py-1 text-xs text-content/55`;
  if (!note.target)
    return (
      <div className={frame} data-agent-note={note.kind}>
        <span>{text}</span>
      </div>
    );
  return (
    <div className={frame} data-agent-note={note.kind}>
      <button type="button" data-agent-note-open={note.target} title="Open this chat" onClick={() => openAgentNote(note)}
        className="min-w-0 truncate text-left underline-offset-2 hover:text-content hover:underline">
        {text}
      </button>
    </div>
  );
}
