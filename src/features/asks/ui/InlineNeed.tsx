// A question answered where it sits in the Chief of Staff's one chat (Ash's round 3 pick, 13 Nov): the Needs you
// item's own card, the one the Inbox and the Needs you list open (needs/ui/NeedDetail.tsx), drawn in the chat. A
// reply links it (asks/model/needLinks.ts) and the Needs you roll-up names its items this way. Once it no longer
// waits on Ash it folds to one quiet line.
import { useRef } from "react";
import { Check } from "../../../shared/ui/icons";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { useLastAnswered } from "../../needs/model/answeredNeeds";
import { askedAgo, NEED_KIND_LABEL } from "../../needs/model/needContext";
import { useNeedsYou } from "../../needs/model/needsLive";
import type { RollupCard } from "../../needs/model/needsRollup";
import { AnsweredLine, NeedDetail } from "../../needs/ui/NeedDetail";
import { findNeed, needKeyOf } from "../model/needLinks";
import { lensTag } from "../model/chiefLens";

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One Needs you item as a card in the chat. `label` is what the chat still says once it no longer waits. */
export function InlineNeed({ needKey, label, number }: { needKey: string; label: string; number?: number }) {
  useHubDataVersion();
  const item = findNeed(useNeedsYou(), needKey);
  // The item's own key, kept after it leaves the list, so the answer just given still shows where it was given.
  const seen = useRef(needKey);
  if (item) seen.current = item.key;
  const answered = useLastAnswered(seen.current);
  if (!item) {
    if (answered) return <AnsweredLine entry={answered} className="my-1.5 font-sans" />;
    const words = flat(label);
    return (
      <p data-inline-need="settled" className="my-1.5 flex items-center gap-2 font-sans text-[12px] leading-5 text-content/60">
        <Check aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0">{words ? `No longer needs you: ${words}` : "No longer needs you."}</span>
      </p>
    );
  }
  const project = item.projectId ? hubData().listProjects().find((entry) => entry.id === item.projectId)?.name : undefined;
  return (
    <div
      data-inline-need={item.key}
      data-inline-need-project={item.projectId ? lensTag(item.projectId) : undefined}
      className="my-2 flex max-w-[640px] flex-col rounded-lg border border-stroke bg-surface font-sans text-content"
    >
      <div className="flex flex-col gap-1 px-3 pt-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-content/50">
          {number ? (
            <span data-inline-need-number className="shrink-0 tabular-nums text-content/70">
              {number}.
            </span>
          ) : (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: NEEDS_YOU_RED }} />
          )}
          <span className="shrink-0 text-content/70">{NEED_KIND_LABEL[item.kind]}</span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{[project, item.who, askedAgo(item.at, Date.now())].filter(Boolean).join(" · ")}</span>
        </div>
        <p data-inline-need-sentence className="whitespace-pre-wrap break-words text-[14px] font-medium leading-5">
          {item.sentence}
        </p>
      </div>
      <NeedDetail item={item} compact />
    </div>
  );
}

/** The renderer the markdown lends need links to (sessions/model/inlineLinkCards.ts). */
export function inlineNeedCard(href: string, label: string) {
  const key = needKeyOf(href);
  return key ? <InlineNeed needKey={key} label={label} /> : undefined;
}

/**
 * What newly needs Ash, in the one chat (needs/model/needsRollup.ts): a quiet heading, then each item's own card,
 * numbered, so he answers them where he reads them.
 */
export function NeedsRollupCard({ card, embedded = false }: { card: RollupCard; embedded?: boolean }) {
  const many = card.items.length > 1;
  return (
    <section aria-label="Needs you now" data-needs-rollup={card.items.length} className={`${embedded ? "" : "px-4"} py-2 font-sans`}>
      <h3 className="flex items-center gap-1.5 text-[12px] leading-5 text-content/60">
        <span aria-hidden className="size-1.5 rounded-full" style={{ background: NEEDS_YOU_RED }} />
        Needs you now
        {many ? <span className="text-content/45">{card.items.length}</span> : null}
      </h3>
      {card.items.map((item, index) => (
        <InlineNeed key={item.key} needKey={item.key} label={item.sentence} number={many ? index + 1 : undefined} />
      ))}
      {card.more > 0 ? <p className="text-[12px] leading-5 text-content/60">And {card.more} more in Needs you.</p> : null}
    </section>
  );
}
