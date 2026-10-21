// An agent-to-agent note in a chat (model/agentNotes.ts, CoS's data). Critiquito's look: one quiet line, muted grey,
// no bubble, no log; the agent with a chat to open is its clickable name (no chat: plain text, never a dead link).
// Several landing together fold into one line that expands (AgentNoteGroup). Words: model/agentNoteView.ts.
import { useState } from "react";
import { ChevronRight } from "../../../shared/ui/icons";
import type { AgentNote } from "../model/agentNotes";
import { agentNoteText } from "../model/agentNotes";
import { delegationActions } from "../model/delegationStore";
import { foldedLine, noteParts } from "../model/agentNoteView";

/** Opens the note's chat under the chat that owns the work. */
export function openAgentNote(note: AgentNote): void {
  if (note.target) delegationActions()?.openChild(note.from.session === note.target ? note.to.session : note.from.session, note.target);
}

const LINE = "flex min-w-0 items-baseline gap-1 py-0.5 font-sans text-[12px] leading-5 text-content/50";

function NoteWords({ note }: { note: AgentNote }) {
  const { head, line } = noteParts(note);
  return (
    <span className="min-w-0 truncate">
      {head.map((part, i) =>
        part.kind === "name" && part.opens ? (
          <button key={i} type="button" data-agent-note-open={part.opens} title={`Open ${part.text}'s chat`} onClick={() => openAgentNote(note)}
            className="font-medium text-content/70 underline-offset-2 hover:text-content hover:underline">
            {part.text}
          </button>
        ) : (
          <span key={i} className={part.kind === "name" ? "text-content/65" : undefined}>{part.text}</span>
        ),
      )}
      {line ? <span className="text-content/40">: {line}</span> : null}
    </span>
  );
}

export function AgentNoteRow({ note, embedded = false }: { note: AgentNote; embedded?: boolean }) {
  return (
    <div className={`${embedded ? "" : "px-4"} ${LINE}`} data-agent-note={note.kind} aria-label={agentNoteText(note)} role="note">
      <NoteWords note={note} />
    </div>
  );
}

/** Notes that landed together: one line, the count and each head; a click shows each note on its own line. */
export function AgentNoteGroup({ notes, embedded = false }: { notes: readonly AgentNote[]; embedded?: boolean }) {
  const [open, setOpen] = useState(false);
  const pad = embedded ? "" : "px-4";
  return (
    <div className={pad} data-agent-note-group={notes.length} data-open={open || undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} data-agent-note-fold
        className={`${LINE} w-full text-left hover:text-content/75`}>
        <ChevronRight className={`size-3 shrink-0 self-center transition-transform ${open ? "rotate-90" : ""}`} strokeWidth={2} aria-hidden />
        <span className="min-w-0 truncate">{foldedLine(notes)}</span>
      </button>
      {open ? (
        <div className="ml-1.5 border-l border-content/10 pl-3">
          {notes.map((note) => (
            <AgentNoteRow key={`${note.taskId}-${note.kind}-${note.at}`} note={note} embedded />
          ))}
        </div>
      ) : null}
    </div>
  );
}
