// A room's turn, or another Mono's private message, in a Mono's own chat (hub rooms, docs/leadership/ROOM.md): the
// hidden prompt and this chat's answer, as one quiet line that opens on a click, like the checker's note
// (CheckTurnCard). Never Ash's words, and the agents' talk stays out of his 1:1 (Ash, 19 Oct).
import { useState } from "react";
import type { Block } from "../../sessions/model/session";
import { ChevronDown, ChevronRight, Loader, MessageMultiple } from "../../../shared/ui/icons";
import { isSilent } from "../model/roomTurns";
import { appNoteTitle } from "../model/appNoteTitle";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";

/** The chat's own answer: the last thing it said in the turn. */
function finalReply(turn: readonly Block[]): string {
  for (let i = turn.length - 1; i > 0; i--) {
    const block = turn[i];
    if (block.role === "assistant" && !block.tool && !block.internal && block.text.trim()) return block.text.trim();
  }
  return "";
}

/** It answered with room_post or mono_message rather than its turn's text. */
function usedTool(turn: readonly Block[], name: RegExp): boolean {
  return turn.some((block) => block.role === "assistant" && !!block.tool && name.test(JSON.stringify(block.tool)));
}

export function RoomNoteCard({
  turn,
  live,
  agentName,
}: {
  /** The hidden prompt first, then the chat's work and answer. */
  turn: readonly Block[];
  /** The chat is still answering it. */
  live: boolean;
  agentName?: string;
}) {
  const [open, setOpen] = useState(false);
  const note = turn[0].monoNote;
  const reply = finalReply(turn);
  const said = reply && !isSilent(reply) ? reply : "";
  const room = note?.kind === "room";
  // Another Mono's answer to a message this chat sent for Ash (useRoomRunner relayReplies): what this chat makes of it
  // is for Ash, so it shows as a normal message under the line, not inside it (Ash 12 Nov 20:42).
  const forOwner = !room && !!turn[0].appRequestId?.endsWith("-reply");
  const shownToOwner = forOwner && !live && !!said;
  const answeredByTool = usedTool(turn, room ? /room_post|rooms\.post/ : /mono_message|monos\.message/);
  const state = live
    ? room
      ? "answering in the room"
      : "reading it now"
    : said || answeredByTool
      ? room
        ? note?.line ?? "answered in the room"
        : shownToOwner
          ? "answered"
          : "replied"
      : room
        ? "nothing new to add"
        : "no reply needed";
  // r91 (Critiquito: "From Self-repair · reading it" didn't say what happened): who sent this chat a message, then
  // what this chat did with it.
  // r94 (Critiquito e): a note from the app itself says what the app asked, like the app notes.
  const fromApp = room ? undefined : appNoteTitle(note?.from, note?.line);
  const title = room
    ? `${note?.from ?? "Room"} · ${state}`
    : fromApp
      ? `${fromApp} · ${state}`
      : `${note?.from ?? "Another Mono"} sent this chat a message · ${state}`;
  return (
    <div className="transcript-turn flex min-w-0 flex-col px-4 py-1" data-mono-note={note?.kind} data-mono-note-ref={note?.ref}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-1 text-left font-sans text-[12px] text-content/50 transition-colors hover:bg-content/5 hover:text-content/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {live ? (
          <Loader className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={1.75} />
        ) : (
          <MessageMultiple className="size-3.5 shrink-0" strokeWidth={1.75} />
        )}
        <span className="min-w-0 truncate">{title}</span>
        {open ? <ChevronDown className="size-3 shrink-0" strokeWidth={1.75} /> : <ChevronRight className="size-3 shrink-0" strokeWidth={1.75} />}
      </button>
      {open ? (
        <div className="mt-1 ml-1 flex max-w-[40rem] flex-col gap-1.5 border-l border-content/10 pl-3 font-sans text-[12.5px] leading-relaxed text-content/65">
          {!room && note?.line ? (
            <p className="whitespace-pre-wrap">
              <span className="text-content/45">{note.from} wrote: </span>
              {note.line}
            </p>
          ) : null}
          {shownToOwner ? null : said ? (
            <p className="whitespace-pre-wrap">
              <span className="text-content/45">{agentName ?? "This chat"} {room ? "said in the room" : "answered"}: </span>
              {said}
            </p>
          ) : (
            <p className="text-content/45">{answeredByTool ? (room ? "Its answer is in the room." : "It answered privately.") : room ? "It had nothing new for the room." : "It had nothing to say back."}</p>
          )}
        </div>
      ) : null}
      {shownToOwner ? (
        <div data-chat-message-role="assistant" className="min-w-0 pt-2 pb-1 text-content">
          <AgentMarkdown text={said} />
        </div>
      ) : null}
    </div>
  );
}
