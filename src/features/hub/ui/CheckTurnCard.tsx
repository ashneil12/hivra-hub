// A `[MonoCode check]` turn in the chat that owns one of Ash's messages (hub/model/hubChecks.ts): the checker's private
// note and this chat's answer, as one quiet line that opens on a click. Never Ash's words, never on Today (Ash, 19 Oct:
// "that shows private between the two AIs").
import { useState } from "react";
import type { Block } from "../../sessions/model/session";
import { ChevronDown, ChevronRight, Eye, Loader } from "../../../shared/ui/icons";
import { lastReply } from "../model/claimEvidence";
import { checkClaim, checkVerdict } from "../model/hubChecks";
import { forYou } from "../model/userName";

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
  const reply = lastReply(turn);
  const verdict = checkVerdict(turn);
  // A "fixed" carries its evidence (claimEvidence.ts): verified, likely, or a guess the line says is not proven.
  const claim = reply ? checkClaim(turn) : undefined;
  const worth =
    verdict && claim ? (claim.confidence === "verified" ? "verified" : claim.confidence === "likely" ? "likely" : "not proven") : "";
  const state = live
    ? "looking at it"
    : verdict
      ? `answered: ${verdict}${worth ? `, ${worth}` : ""}`
      : reply
        ? "answered"
        : "not answered";
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
            {check?.finding ?? forYou("something about one of Ash's messages.")}
          </p>
          {reply ? (
            <p className="whitespace-pre-wrap">
              <span className="text-content/45">{agentName ?? "This chat"} answered: </span>
              {reply}
            </p>
          ) : null}
          {claim ? (
            <p className="whitespace-pre-wrap text-content/55" data-claim-confidence={claim.confidence}>
              <span className="text-content/45">Evidence: </span>
              {claim.line}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
