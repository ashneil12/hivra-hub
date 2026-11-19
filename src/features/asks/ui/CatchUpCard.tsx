// The "Catch me up" card in the one chat (asks/model/catchUp.ts): one quiet line that sums it, then what finished, what
// was decided for him and what needs him, as rows on hairlines. Every row is the same two lines: what it is, then its
// project and what came of it. A job opens its chat; a row that still needs him opens its own card where it is (the
// Inbox's NeedDetail), so nothing here sends him to another screen to answer.
import { useState } from "react";
import { Check } from "../../../shared/ui/icons";
import { CircleWord } from "../../hub/ui/StatusMark";
import { openFromHome } from "../../home/model/opener";
import { openBesideChief } from "../model/besideChat";
import { useNeedsYou } from "../../needs/model/needsLive";
import { NeedDetail } from "../../needs/ui/NeedDetail";
import { Reveal } from "../../needs/ui/Reveal";
import { CATCH_UP_FIRST_LOOKBACK_MS, catchUpSummary, type CatchUp } from "../model/catchUp";

const QUIET = "shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content focus-visible:outline-2 focus-visible:outline-accent";
const REVEAL = "opacity-0 focus-visible:opacity-100 group-hover:opacity-100";
const ROW = "group flex items-start gap-2 border-t border-stroke px-3 py-1.5";
const NAME = "text-[13px] leading-[18px] text-content";
const UNDER = "text-[12px] leading-4 text-content/60";
/** Every row's state sits in the same 14px column, so names line up down the card. */
const GLYPH = "mt-0.5 flex size-3.5 shrink-0 items-center justify-center";

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "2:05 PM to 3:46 PM", with the day when the last catch-up was not today, or "The last day" for a chat's first one. */
export function rangeWords(since: number, at: number): string {
  if (at - since >= CATCH_UP_FIRST_LOOKBACK_MS) return `The last day, up to ${clock(at)}`;
  const from = new Date(since);
  const same = from.toDateString() === new Date(at).toDateString();
  return `${same ? "" : `${from.toLocaleDateString([], { weekday: "short" })} `}${clock(since)} to ${clock(at)}`;
}

function Heading({ label, count }: { label: string; count: number }) {
  return (
    <h4 className="flex items-baseline gap-1.5 px-3 pb-1 pt-3 text-[12px] leading-5">
      <span className="font-medium text-content">{label}</span>
      <span className="tabular-nums text-content/60">{count}</span>
    </h4>
  );
}

function More({ count, tail = "" }: { count: number; tail?: string }) {
  if (!count) return null;
  return (
    <li className={`${ROW} ${UNDER}`}>
      <span className={GLYPH} />
      and {count} more{tail}
    </li>
  );
}

/** The line under a row's name: its project, then what came of it. */
function Under({ parts }: { parts: (string | undefined | false)[] }) {
  const shown = parts.filter((part): part is string => !!part);
  return shown.length ? <span className={`truncate ${UNDER}`}>{shown.join(" · ")}</span> : null;
}

export function CatchUpCard({ doc, embedded = false }: { doc: CatchUp; embedded?: boolean }) {
  const live = useNeedsYou();
  const [open, setOpen] = useState<string | null>(null);
  const finished = doc.finished.length + doc.finishedMore;
  const decided = doc.decided.length + doc.decidedMore;
  const needs = doc.needs.length + doc.needsMore;
  return (
    <div className={`${embedded ? "" : "px-4"} py-2`}>
      <section data-catch-up={doc.at} aria-label="Catch-up" className="max-w-[720px] overflow-hidden rounded-lg border border-stroke pb-1 font-sans">
        <header className="flex items-baseline gap-2 px-3 pt-2.5">
          <h3 className="text-[13px] font-medium leading-5 text-content">Catch-up</h3>
          <span className="text-[12px] tabular-nums leading-5 text-content/60">
            {rangeWords(doc.since, doc.at)}
          </span>
        </header>
        <p data-catch-up-summary className="px-3 pb-1.5 pt-0.5 text-[13px] leading-[18px] text-content/80">
          {catchUpSummary(doc)}
        </p>
        {finished ? (
          <>
            <Heading label="Finished" count={finished} />
            <ul className="flex flex-col">
              {doc.finished.map((job) => (
                <li key={job.id} data-catch-up-job={job.id} className={ROW}>
                  <span className={GLYPH}>
                    {job.ok ? <Check aria-label="Done" className="size-3.5 text-content/60" strokeWidth={1.75} /> : <CircleWord circle="grey" word="Stopped" ringOnly />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate ${NAME}`}>{job.title}</span>
                    <Under parts={[job.project, job.ok ? job.line : `Stopped${job.line ? `: ${job.line}` : ""}`]} />
                  </span>
                  {job.chat ? (
                    <button
                      type="button"
                      className={`${QUIET} ${REVEAL}`}
                      aria-label={`Open ${job.title}`}
                      onClick={() => {
                        // Beside the one chat when it is on screen, so the catch-up stays where it is.
                        if (!openBesideChief(job.chat)) openFromHome({ kind: "chat", id: job.chat as string, projectId: job.projectId ?? "" });
                      }}
                    >
                      Open
                    </button>
                  ) : null}
                </li>
              ))}
              <More count={doc.finishedMore} />
            </ul>
          </>
        ) : null}
        {decided ? (
          <>
            <Heading label="Decided for you" count={decided} />
            <ul className="flex flex-col">
              {doc.decided.map((item) => (
                <li key={item.key} data-catch-up-decided className={ROW}>
                  <span className={GLYPH}>
                    <Check aria-label="Decided" className="size-3.5 text-content/60" strokeWidth={1.75} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={NAME}>
                      {item.question} <span className="font-medium">{item.answer}</span>
                    </span>
                    <Under parts={[item.project, item.why]} />
                  </span>
                </li>
              ))}
              <More count={doc.decidedMore} />
            </ul>
          </>
        ) : null}
        {needs ? (
          <>
            <Heading label="Needs you" count={needs} />
            <ul className="flex flex-col">
              {doc.needs.map((item) => {
                const now = live.find((entry) => entry.key === item.key);
                const shown = open === item.key && now;
                return (
                  <li key={item.key} data-catch-up-need={now ? "open" : "answered"} className="flex flex-col border-t border-stroke">
                    <div className="group flex items-start gap-2 px-3 py-1.5">
                      <span className={GLYPH}>
                        <CircleWord circle={now ? "red" : "grey"} word={now ? "Needs you" : "Answered"} ringOnly />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={`${NAME} ${now ? "" : "text-content/60"}`}>{item.sentence}</span>
                        <Under parts={[item.project, now ? item.who : "Answered since"]} />
                      </span>
                      {now ? (
                        <button type="button" className={QUIET} aria-expanded={!!shown} aria-label={`Answer: ${item.sentence}`} onClick={() => setOpen(shown ? null : item.key)}>
                          {shown ? "Close" : "Answer"}
                        </button>
                      ) : null}
                    </div>
                    {shown ? (
                      <Reveal>
                        <NeedDetail item={now} compact />
                      </Reveal>
                    ) : null}
                  </li>
                );
              })}
              <More count={doc.needsMore} tail=" in Needs you" />
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
