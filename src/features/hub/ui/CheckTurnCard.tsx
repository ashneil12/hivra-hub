// A `[MonoCode check]` turn in the chat that owns one of Ash's messages (hub/model/hubChecks.ts): the checker's private
// note and this chat's answer, as one quiet line that opens on a click. Never Ash's words, never on Today (Ash, 19 Oct:
// "that shows private between the two AIs").
import { useState } from "react";
import type { Block } from "../../sessions/model/session";
import { ChevronDown, ChevronRight, Eye, Loader } from "../../../shared/ui/icons";
import { checkVerdict } from "../model/hubChecks";

/** The chat's own answer: the last thing it said in the turn. */
function finalReply(turn: readonly Block[]): string {
  for (let i = turn.length - 1; i > 0; i--) {
    const block = turn[i];
    if (block.role === "assistant" && !block.tool && !block.internal && block.text.trim()) return block.text.trim();
  }
  return "";
}

export function CheckTurnCard({
  turn,
  live,
  agentName,
}: {
  /** The check prompt first, then the chat's work and answer. */
  turn: readonly Block[];
  /** The chat is still answering it. */
  live: boolean;
  agentName?: string;
}) {
  const [open, setOpen] = useState(false);
  const check = turn[0].monoCheck;
  const reply = finalReply(turn);
  const verdict = checkVerdict(turn);
  const state = live ? "looking at it" : verdict ? `answered: ${verdict}` : reply ? "answered" : "not answered";
  return (
    <div className="transcript-turn flex min-w-0 flex-col px-4 py-1" data-mono-check={check?.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-1 text-left font-sans text-[12px] text-content/50 transition-colors hover:bg-content/5 hover:text-content/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {live ? (
          <Loader className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={1.75} />
        ) : (
          <Eye className="size-3.5 shrink-0" strokeWidth={1.75} />
        )}
        <span className="min-w-0 truncate">Checker's note · {state}</span>
        {open ? (
          <ChevronDown className="size-3 shrink-0" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="size-3 shrink-0" strokeWidth={1.75} />
        )}
      </button>
      {open ? (
        <div className="mt-1 ml-1 flex max-w-[40rem] flex-col gap-1.5 border-l border-content/10 pl-3 font-sans text-[12.5px] leading-relaxed text-content/65">
          <p className="whitespace-pre-wrap">
            <span className="text-content/45">The checker noticed: </span>
            {check?.finding ?? "something about one of Ash's messages."}
          </p>
          {reply ? (
            <p className="whitespace-pre-wrap">
              <span className="text-content/45">{agentName ?? "This chat"} answered: </span>
              {reply}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
