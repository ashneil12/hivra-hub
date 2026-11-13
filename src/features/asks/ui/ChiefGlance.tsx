// One main chat (Ash, 13 Nov: "i like a"): the Chief of Staff's chat carries three chips beside its own buttons, each
// opening over the chat. Needs you is the Inbox's own list and card; You asked is the ask ledger (hub/model/askLedger.ts),
// so nothing he asked for is lost in a long chat; Working is every job in every project, with the way in to take one over.
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "../../../shared/ui/Popover";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { CircleWord } from "../../hub/ui/StatusMark";
import { openFromHome } from "../../home/model/opener";
import { findMono } from "../../monos/model/mono";
import { handBack, hasJumpedIn, useDelegationRows, useDelegationsVersion } from "../../monos/model/delegationStore";
import { InboxNeeds } from "../../needs/ui/InboxNeeds";
import { AnsweredLine, NeedDetail } from "../../needs/ui/NeedDetail";
import { useLastAnswered } from "../../needs/model/answeredNeeds";
import { quoteAsked, quoteInChat, quoteJob, quoteNeed } from "../model/quoteInChat";
import { openBesideChief } from "../model/besideChat";
import { useNeedsYou } from "../../needs/model/needsLive";
import { readAskLedger, subscribeAskLedger, type LedgerAsk } from "../../hub/model/askLedger";
import { JOB_WORD, jobGroups, jobStatus, openJobCount } from "../model/chiefJobs";

let ledgerVersion = 0;
subscribeAskLedger(() => {
  ledgerVersion += 1;
});

/** The asks he made that are still on the list (dropped ones are gone), newest first. */
function useAsked(): LedgerAsk[] {
  const version = useSyncExternalStore(subscribeAskLedger, () => ledgerVersion, () => 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readAskLedger().filter((row) => row.status !== "dropped").reverse(), [version]);
}

const ASKED_WORD: Record<LedgerAsk["status"], string> = { open: "Open", handled: "Done", parked: "Set aside", dropped: "Dropped" };

const HINT = "px-2 py-2 text-[12px] leading-4 text-content/60";
const QUIET = "shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content";
const REVEAL = "opacity-0 focus-visible:opacity-100 group-hover:opacity-100";

export function useChiefCounts(): { needs: number; asked: number; working: number } {
  const needs = useNeedsYou().length;
  const asked = useAsked().filter((item) => item.status === "open").length;
  const working = openJobCount(useDelegationRows());
  return { needs, asked, working };
}

/**
 * The one Needs you list, answered where it is: a row slides its card open under itself (every answer, his own words),
 * and the answer's line stays a moment after the row leaves, so the tap is seen to land.
 */
export function ChiefNeeds({ onQuote }: { onQuote?: (text: string) => void } = {}) {
  const [picked, setPicked] = useState<string | null>(null);
  const count = useNeedsYou().length;
  const answered = useLastAnswered();
  return (
    <div data-chief-needs className="-mx-2 -my-2 flex flex-col">
      {answered ? <AnsweredLine entry={answered} className="px-4 pb-1 pt-3" /> : null}
      {count === 0 && !answered ? <p className={`${HINT} px-4 pt-3`}>Nothing needs you right now.</p> : null}
      <InboxNeeds
        pick={{
          picked,
          onPick: (item) => setPicked(item.key === picked ? null : item.key),
          renderOpen: (item) => <NeedDetail item={item} compact />,
        }}
        onQuote={onQuote ? (item, project) => onQuote(quoteNeed(item, project)) : undefined}
      />
    </div>
  );
}

/** Everything the owner asked for, newest first: still open, done (with what closed it) or set aside. */
export function ChiefAsked({ onQuote }: { onQuote?: (text: string) => void } = {}) {
  const asked = useAsked();
  if (asked.length === 0) return <p className={HINT}>What you ask for shows here, so nothing gets lost in a long chat.</p>;
  return (
    <ul data-chief-asked className="flex flex-col">
      {asked.map((item, index) => {
        const note = item.status === "handled" ? item.evidence : item.gap;
        return (
          <li key={item.id} data-asked={item.status} className={`group flex items-start gap-2 px-2 py-2${index ? " border-t border-stroke" : ""}`}>
            <span className="mt-0.5">
              <CircleWord circle={item.status === "open" && item.gap ? "red" : "grey"} word={ASKED_WORD[item.status]} ringOnly />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`text-[13px] leading-[18px] ${item.status === "open" ? "text-content" : "text-content/60"}`}>{item.title}</span>
              <span className="text-[11px] leading-4 text-content/60">
                {ASKED_WORD[item.status]}
                {item.said && item.said > 1 ? ` · said ${item.said} times` : ""}
                {note ? ` · ${note}` : ""}
              </span>
            </span>
            {onQuote ? (
              <button
                type="button"
                data-quote-asked={item.id}
                aria-label={`Quote in the chat: ${item.title}`}
                className={`${QUIET} ${REVEAL}`}
                onClick={() => onQuote(quoteAsked({ title: item.title, status: ASKED_WORD[item.status], note: note ?? undefined, said: item.said }))}
              >
                Quote
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Every job in every project, grouped by project, with the way in to take one over. */
export function ChiefWorking({
  onQuote,
  besideOpen = false,
  onBeside,
}: {
  onQuote?: (text: string) => void;
  /** The Chief of Staff's chat is on screen, so a first mate's chat can open beside it. */
  besideOpen?: boolean;
  onBeside?: () => void;
} = {}) {
  useHubDataVersion();
  useDelegationsVersion();
  const rows = useDelegationRows();
  const groups = jobGroups(rows, hubData().listProjects());
  if (groups.length === 0) return <p className={HINT}>Nothing running right now.</p>;
  return (
    <div data-chief-working className="flex flex-col gap-3">
      {groups.map(({ projectId, name, rows: list }) => {
        const leadMono = list.map((row) => (row.ownerMono ? findMono(row.ownerMono) : undefined)).find(Boolean);
        const lead = leadMono?.name;
        // The project's first mate's own chat for it: where a message to "the EXO lead" goes.
        const leadChat = leadMono ? ((projectId ? leadMono.projectSessions?.[projectId] : undefined) ?? leadMono.sessionId) : undefined;
        return (
          <section key={projectId ?? "none"} aria-label={name} className="flex flex-col">
            <h3 className="group flex items-baseline gap-1.5 px-2 pb-1 text-[12px] leading-5">
              <span className="font-medium text-content">{name}</span>
              <span className="text-content/60">
                {lead ? `${lead} · ` : ""}
                {list.length} {list.length === 1 ? "job" : "jobs"}
              </span>
              {lead && leadChat && besideOpen ? (
                <button
                  type="button"
                  data-message-lead={leadChat}
                  aria-label={`Message ${lead} beside this chat`}
                  className={`ml-auto ${QUIET}`}
                  onClick={() => {
                    if (openBesideChief(leadChat)) onBeside?.();
                  }}
                >
                  Message {lead}
                </button>
              ) : null}
            </h3>
            <ul className="flex flex-col">
              {list.map((row) => {
                const status = jobStatus(row) ?? "working";
                const red = status === "needs-you";
                const word = JOB_WORD[status];
                const mine = hasJumpedIn(row.childSession);
                // The job's own first mate, not the first one in the project.
                const owner = row.ownerMono ? findMono(row.ownerMono)?.name : undefined;
                return (
                  <li key={row.id} data-chief-job={row.id} className="group flex items-start gap-2 border-t border-stroke px-2 py-1.5">
                    <span className="mt-0.5">
                      <CircleWord circle={red ? "red" : "grey"} word={word} ringOnly />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] leading-[18px] text-content">{row.title ?? row.goal ?? "Untitled work"}</span>
                      <span className="truncate text-[11px] leading-4 text-content/60">
                        {mine ? "You're driving this one" : (row.statusNotice ?? word)}
                      </span>
                    </span>
                    {onQuote ? (
                      <button
                        type="button"
                        data-quote-job={row.id}
                        aria-label={`Quote in the chat: ${row.title ?? row.goal ?? "Untitled work"}`}
                        className={`${QUIET} ${REVEAL}`}
                        onClick={() =>
                          onQuote(
                            quoteJob({
                              title: row.title ?? row.goal ?? "Untitled work",
                              project: name,
                              lead: owner,
                              state: mine ? "You're driving this one" : (row.statusNotice ?? word),
                            }),
                          )
                        }
                      >
                        Quote
                      </button>
                    ) : null}
                    {mine ? (
                      <button type="button" data-hand-back className={QUIET} aria-label={`Hand ${row.title ?? "this job"} back${owner ? ` to ${owner}` : ""}`} onClick={() => handBack(row.childSession)}>
                        Hand back{owner ? ` to ${owner}` : ""}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-take-over
                        className={`${QUIET} ${REVEAL}`}
                        aria-label={`Open ${row.title ?? "this job"}`}
                        onClick={() => {
                          // Beside the Chief of Staff's chat when it is on screen, so he reads it without leaving.
                          if (!openBesideChief(row.childSession)) openFromHome({ kind: "chat", id: row.childSession, projectId: row.project ?? "" });
                        }}
                      >
                        Open
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** The three lists as chips beside the chat's own buttons, each opening over the chat. */
export function ChiefChips({ quoteTo }: { quoteTo?: string } = {}) {
  const counts = useChiefCounts();
  const [open, setOpen] = useState<"needs" | "asked" | "working" | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  // A quoted row lands in the chat's box, not sent, and the list closes so he can say what he wants about it.
  const quote = quoteTo
    ? (text: string) => {
        if (quoteInChat(quoteTo, text)) setOpen(null);
      }
    : undefined;
  const chips = [
    { id: "needs" as const, label: "Needs you", count: counts.needs },
    { id: "asked" as const, label: "You asked", count: counts.asked },
    { id: "working" as const, label: "Working", count: counts.working },
  ];
  return (
    <div ref={anchor} data-chief-chips className="flex items-center gap-1" data-tauri-drag-region="false">
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          aria-pressed={open === chip.id}
          data-chief-chip={chip.id}
          onClick={() => setOpen(open === chip.id ? null : chip.id)}
          className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] ${
            open === chip.id ? "bg-content/10 text-content" : "bg-content/5 text-content/70 hover:bg-content/8 hover:text-content"
          }`}
        >
          {chip.label}
          <span className="tabular-nums" style={chip.id === "needs" && chip.count ? { color: NEEDS_YOU_RED } : undefined}>
            {chip.count}
          </span>
        </button>
      ))}
      {open ? (
        <Popover anchor={anchor} side="bottom" align="end" width={440} maxHeight={620} onDismiss={() => setOpen(null)} role="dialog" aria-label={chips.find((chip) => chip.id === open)?.label} ignore="[data-chief-chips]" className="solid-panel-glass font-sans">
          <div className="max-h-[600px] overflow-y-auto px-2 py-2">
            {open === "needs" ? <ChiefNeeds onQuote={quote} /> : open === "asked" ? <ChiefAsked onQuote={quote} /> : <ChiefWorking onQuote={quote} besideOpen={!!quoteTo} onBeside={() => setOpen(null)} />}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
