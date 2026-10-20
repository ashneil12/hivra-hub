// A room's messages and its status line (docs/leadership/ROOM.md), in the group chat's own look (GroupChatView): Ash's
// bubble, a Mono's name over its words, the reactions that replace "got it" bubbles, a notice when a Mono couldn't
// answer (never silence), the app's quiet lines, and the line above the composer that says who is working, with Stop,
// or that the team paused for Ash, with Keep going.
import type { ReactNode } from "react";
import {
  keepGoing,
  react,
  REACTIONS,
  retryNotice,
  roomActive,
  roomPauseReason,
  roomRouting,
  roomWorking,
  stopRoom,
} from "../model/hubChats";
import type { ChatMessage } from "../model/types";

const shorten = (text: string, max = 70) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "frank", "frank and PM", "frank, PM and Alfred". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function Reactions({ chatId, message, nameOf, align = "start" }: { chatId: string; message: ChatMessage; nameOf: (id: string) => string; align?: "start" | "end" }) {
  const entries = Object.entries(message.reactions ?? {}).filter(([, who]) => who.length);
  if (!entries.length) return null;
  return (
    <div className={`flex flex-wrap gap-1 pt-1 ${align === "end" ? "justify-end" : ""}`} data-hub-msg-reactions>
      {entries.map(([emoji, who]) => (
        <button
          key={emoji}
          type="button"
          title={namesList(who.map((id) => (id === "ash" ? "You" : nameOf(id))))}
          onClick={() => react(chatId, message.id, "ash", emoji)}
          className={`flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] ${who.includes("ash") ? "bg-content/14 text-content" : "bg-content/8 text-content/70"} hover:bg-content/12`}
        >
          <span>{emoji}</span>
          <span>{who.length > 1 ? who.length : who[0] === "ash" ? "You" : nameOf(who[0])}</span>
        </button>
      ))}
    </div>
  );
}

/** Ash's own quick acknowledgement on a Mono's message, on hover. */
function ReactButtons({ chatId, message }: { chatId: string; message: ChatMessage }) {
  return (
    <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {REACTIONS.filter((e) => e !== "👀").map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-label={`React ${emoji}`}
          data-hub-react={emoji}
          onClick={() => react(chatId, message.id, "ash", emoji)}
          className="grid size-5 place-items-center rounded-md text-[11px] hover:bg-content/8"
        >
          {emoji}
        </button>
      ))}
    </span>
  );
}

export function RoomMessage({
  chatId,
  message,
  previous,
  messages,
  nameOf,
  children,
}: {
  chatId: string;
  message: ChatMessage;
  previous?: ChatMessage;
  messages: readonly ChatMessage[];
  nameOf: (id: string) => string;
  /** A Mono's words, as the chat renders them. */
  children?: ReactNode;
}) {
  if (message.from === "ash")
    return (
      <div className="flex flex-col items-end" data-hub-msg-id={message.id}>
        <div className="agent-chat-user-bubble max-w-[70%] rounded-2xl bg-content/10 px-3 py-1.5 text-content">{message.text}</div>
        <Reactions chatId={chatId} message={message} nameOf={nameOf} align="end" />
      </div>
    );
  if (message.kind === "notice")
    return (
      <div role="status" className="flex items-baseline gap-2 text-[12px] leading-5 text-content/70" data-hub-msg-notice={message.notice?.mono ?? true}>
        <span className="min-w-0">{message.text}</span>
        {message.notice?.retry ? (
          <button type="button" onClick={() => void retryNotice(chatId, message.id)} className="shrink-0 underline" data-hub-notice-retry>
            Try again
          </button>
        ) : null}
      </div>
    );
  if (message.kind === "system")
    return (
      <div className="text-center text-xs text-content/50" data-hub-msg-system>
        {message.text}
      </div>
    );
  // A reply to something further up says what it answers; one to the message just above doesn't need to.
  const answered = message.replyTo && message.replyTo !== previous?.id ? messages.find((m) => m.id === message.replyTo) : undefined;
  return (
    <>
      <div className="flex items-center gap-2 pb-0.5 text-xs text-content/60">
        <span title={message.pick?.why} data-hub-msg-pick={message.pick?.by}>
          {nameOf(message.from)}
        </span>
        {answered ? (
          <span className="min-w-0 truncate text-content/45" data-hub-msg-reply-to={answered.id}>
            to {answered.from === "ash" ? "you" : nameOf(answered.from)}: {shorten(answered.text, 60)}
          </span>
        ) : null}
        <ReactButtons chatId={chatId} message={message} />
      </div>
      {children}
      <Reactions chatId={chatId} message={message} nameOf={nameOf} />
    </>
  );
}

function pauseText(reason: string | undefined): string {
  return reason === "stopped"
    ? "You stopped the team. It waits for you."
    : reason === "stalled"
      ? "The team paused here: it stopped making progress."
      : "The team paused here and is waiting for you.";
}

/** The line above the composer: who is working (their own words for it), Stop, or the pause and Keep going. */
export function RoomStatusLine({ chatId, convId, nameOf }: { chatId: string; convId?: string; nameOf: (id: string) => string }) {
  const working = roomWorking(chatId, convId);
  const writing = working.filter((w) => w.state === "writing").map((w) => nameOf(w.monoId));
  const away = working.filter((w) => w.state !== "writing").map((w) => nameOf(w.monoId));
  const paused = convId ? roomPauseReason(chatId, convId) : undefined;
  const active = roomActive(chatId, convId);
  const parts = [
    writing.length ? `${namesList(writing)} ${writing.length > 1 ? "are" : "is"} writing…` : "",
    away.length ? `${namesList(away)} will answer from ${away.length > 1 ? "their own chats" : "its own chat"}…` : "",
    !writing.length && !away.length && roomRouting(chatId, convId) ? "Checking who else has something to add…" : "",
  ].filter(Boolean);
  return (
    <div className="mx-auto flex h-6 w-full max-w-[760px] shrink-0 items-center gap-3 px-8 text-xs text-content/60" data-hub-typing aria-live="polite">
      {parts.length ? <span className="min-w-0 truncate">{parts.join(" ")}</span> : paused ? <span className="min-w-0 truncate" data-hub-room-paused={paused}>{pauseText(paused)}</span> : null}
      {active && convId ? (
        <button type="button" onClick={() => stopRoom(chatId, convId)} className="shrink-0 underline" data-hub-room-stop>
          Stop
        </button>
      ) : paused && convId ? (
        <button type="button" onClick={() => keepGoing(chatId, convId)} className="shrink-0 underline" data-hub-room-keep-going>
          Keep going
        </button>
      ) : null}
    </div>
  );
}
