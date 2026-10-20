// A stuck worker, answerable where Ash sees it (H4; Ash 20 Oct): its question, failure or stall in one line, then one or
// two clicks to answer it (an option, the worker's pick, or his words), tell it what to do, open its chat, stop it, or
// set a failure aside. The same card sits in the Lead's chat (above the composer), on Today and in Being built; only
// the frame differs (`variant`). Answered cards stay as a tick until Ash leaves, so several clear in a row.
import { useState } from "react";
import { Check, CircleAlert, Clock } from "../../../shared/ui/icons";
import { findMono, monoForSession, monoLook } from "../model/mono";
import {
  answerWithOption,
  dismissFailure,
  liveQuestion,
  openStuck,
  questionOptions,
  sendWords,
  stopStuck,
  suggestion,
  takeSuggestion,
  type StuckResult,
} from "../model/stuckActions";
import { leadActionLine, type StuckWorker } from "../model/workerStuck";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-60";
const PRIMARY = "shrink-0 rounded-md bg-content px-2.5 py-1 text-xs font-medium text-background-base hover:opacity-90 disabled:opacity-60";
const QUIET = "shrink-0 rounded-md px-2 py-1 text-xs text-content/55 hover:bg-content/6 hover:text-content disabled:opacity-60";

/** The Mono a worker answers to, by name ("EXO lead"). */
export function leadNameOf(stuck: Pick<StuckWorker, "row">): string {
  const mono = (stuck.row.ownerMono ? findMono(stuck.row.ownerMono) : undefined) ?? monoForSession(stuck.row.ownerSession);
  return mono ? monoLook(mono).name : "its Lead";
}

/** The worker's job, as its Lead named it. */
export function stuckTitle(stuck: Pick<StuckWorker, "row">): string {
  return stuck.row.title?.trim() || "Delegated work";
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  return min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
}

/** A stuck worker's mark, the same as its child row in the Monos rail: amber clock asking, amber or red alert. */
export function StuckMark({ kind, className = "size-3.5" }: { kind: StuckWorker["kind"]; className?: string }) {
  if (kind === "asking") return <Clock className={`${className} shrink-0 text-amber-400`} strokeWidth={1.75} aria-hidden />;
  return (
    <CircleAlert
      className={`${className} shrink-0 ${kind === "failed" ? "text-red-400" : "text-amber-400"}`}
      strokeWidth={1.75}
      aria-hidden
    />
  );
}

/** What the worker is doing about it, after its title: "asking", "not answered yet", "stuck", "failed". */
export function stuckWord(stuck: StuckWorker): string {
  if (stuck.kind === "asking") return stuck.escalated ? "not answered yet" : "asking";
  return stuck.kind === "failed" ? "failed" : "stuck";
}

/** How many cards a Lead's chat shows before "N more stuck": its composer stays in view. */
export const CHAT_CARDS_SHOWN = 3;

type Done = { stuck: StuckWorker; said: string };

export function StuckList({
  stuck,
  now,
  variant,
  where,
  label,
  heading,
}: {
  stuck: readonly StuckWorker[];
  now: number;
  /** `chat`: a bordered card above a Lead's composer; `row`: a quiet row, as on Today and in Being built. */
  variant: "chat" | "row";
  /** What goes before the title on the top line (Today: "Hivra · EXO lead"). */
  where?: (stuck: StuckWorker) => string | undefined;
  label?: string;
  /** A section heading over the list (Today's "Stuck"); the list and its heading go once nothing is left. */
  heading?: string;
}) {
  const [done, setDone] = useState<Record<string, Done>>({});
  const [all, setAll] = useState(false);
  const held = Object.values(done).filter((d) => !stuck.some((s) => s.key === d.stuck.key));
  if (!stuck.length && !held.length) return null;
  const more = variant === "chat" && !all ? Math.max(0, stuck.length - CHAT_CARDS_SHOWN) : 0;
  const cards = more ? stuck.slice(0, CHAT_CARDS_SHOWN) : stuck;
  const finished = (s: StuckWorker, said: string) => setDone((prev) => ({ ...prev, [s.key]: { stuck: s, said } }));
  const list = (
    <div data-stuck-list={variant} aria-label={label} className={variant === "chat" ? "flex flex-col gap-1.5 pb-1.5" : "flex flex-col"}>
      {cards.map((s) =>
        done[s.key] ? (
          <DoneRow key={s.key} done={done[s.key]} variant={variant} />
        ) : (
          <StuckWorkerCard key={s.key} stuck={s} now={now} variant={variant} where={where?.(s)} onDone={(said) => finished(s, said)} />
        ),
      )}
      {held.map((d) => (
        <DoneRow key={d.stuck.key} done={d} variant={variant} />
      ))}
      {more ? (
        <button
          type="button"
          data-stuck-more
          onClick={() => setAll(true)}
          className="self-start rounded-lg px-2 py-0.5 font-sans text-[12px] text-content/55 hover:bg-content/6 hover:text-content"
        >
          {more} more stuck
        </button>
      ) : null}
    </div>
  );
  if (!heading) return list;
  return (
    <section aria-label={heading} data-hub-stuck>
      <h2 className="mb-1 text-xs text-content/60">{heading}</h2>
      {list}
    </section>
  );
}

export function StuckWorkerCard({
  stuck,
  now,
  variant,
  where,
  onDone,
}: {
  stuck: StuckWorker;
  now: number;
  variant: "chat" | "row";
  where?: string;
  onDone?: (said: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const prompt = liveQuestion(stuck);
  const options = questionOptions(prompt);
  const pick = suggestion(prompt, stuck);
  // What its Lead last did about it, so Ash sees someone acted ("Hivra lead retried it at 2h").
  const acted = stuck.kind === "asking" ? undefined : leadActionLine(stuck.row, leadNameOf(stuck));
  const run = async (call: () => StuckResult | Promise<StuckResult>) => {
    setBusy(true);
    setProblem(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) return setProblem(result.reason);
    setText("");
    onDone?.(result.said);
  };
  const send = () => text.trim() && !busy && void run(() => sendWords(stuck, text));
  const frame =
    variant === "chat"
      ? "flex flex-col gap-1 rounded-2xl border border-content/10 px-4 py-3 font-sans text-[13px]"
      : "flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-content/5";
  const placeholder =
    stuck.kind === "asking" ? "Or answer in your words…" : stuck.kind === "stalled" ? "Tell it what to do…" : "Reply in its chat…";
  return (
    <div className={frame} data-stuck-worker={stuck.row.childSession} data-stuck-kind={stuck.kind} data-stuck-escalated={stuck.escalated || undefined}>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-content/60">
        <StuckMark kind={stuck.kind} />
        <span className="min-w-0 truncate" data-stuck-where>
          {[where, stuckTitle(stuck)].filter(Boolean).join(" · ")}
        </span>
        <span className="shrink-0">· {stuckWord(stuck)}</span>
        <span className="ml-auto shrink-0 tabular-nums" data-stuck-ago>
          {ago(now - stuck.since)}
        </span>
      </div>
      <div className="whitespace-normal break-words text-[13px] leading-5 text-content" data-stuck-line>
        {stuck.line}
      </div>
      {acted ? (
        <div className="whitespace-normal break-words text-[12px] leading-5 text-content/60" data-stuck-lead-action>
          {acted}
        </div>
      ) : null}
      {stuck.kind === "asking" && pick && !options.length ? (
        <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-stuck-pick>
          Suggests: {pick}
        </div>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            className={option.recommended ? PRIMARY : BTN}
            data-stuck-option={option.id}
            onClick={() => void run(() => answerWithOption(stuck, option.id))}
          >
            {option.label}
          </button>
        ))}
        {!options.length && pick ? (
          <button type="button" disabled={busy} className={PRIMARY} data-stuck-take-pick onClick={() => void run(() => takeSuggestion(stuck))}>
            Take the pick
          </button>
        ) : null}
        <button type="button" className={BTN} data-stuck-open onClick={() => openStuck(stuck)}>
          Open
        </button>
        {stuck.kind === "failed" ? (
          <button type="button" className={BTN} data-stuck-dismiss onClick={() => dismissFailure(stuck)}>
            Dismiss
          </button>
        ) : (
          <>
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) send();
              }}
              placeholder={placeholder}
              aria-label={`${stuck.kind === "asking" ? "Answer" : "Tell"} ${stuckTitle(stuck)} in your words`}
              maxLength={4000}
              data-stuck-reply
              className="min-w-[8rem] flex-1 rounded-md bg-content/5 px-2.5 py-1 text-[13px] text-content outline-none placeholder:text-content/50 focus:bg-content/10"
            />
            <button type="button" className={BTN} disabled={busy || !text.trim()} data-stuck-send onClick={send}>
              {busy ? "Sending…" : "Send"}
            </button>
            <button type="button" className={QUIET} disabled={busy} data-stuck-stop onClick={() => void run(() => stopStuck(stuck))}>
              Stop
            </button>
          </>
        )}
      </div>
      {problem ? (
        <div className="text-[13px] text-content/60" data-stuck-problem>
          {problem}
        </div>
      ) : null}
    </div>
  );
}

function DoneRow({ done, variant }: { done: Done; variant: "chat" | "row" }) {
  return (
    <div
      className={`flex items-center gap-3 ${variant === "chat" ? "rounded-2xl border border-content/10 px-4 py-2 font-sans" : "rounded-md px-2 py-2"}`}
      data-stuck-done={done.stuck.row.childSession}
    >
      <span className="grid size-5 shrink-0 place-items-center text-content/60" role="img" aria-label="Done">
        <Check className="size-3.5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1 text-[13px] leading-5 text-content/60">
        <span className="text-content/85">{stuckTitle(done.stuck)}</span>: {done.said}
      </div>
    </div>
  );
}
