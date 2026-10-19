import { useEffect, useState } from "react";
import { hubData } from "../model/hubData";
import type { HubAnswer, HubQuestion, Need } from "../model/types";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-60";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-background-base/75" data-hub-sheet={label} onClick={onClose}>
      <div role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()} className="flex max-h-[calc(100vh-96px)] w-[540px] max-w-[calc(100vw-48px)] flex-col gap-4 overflow-y-auto rounded-2xl bg-background-base p-6 shadow-2xl">
        {children}
      </div>
    </div>
  );
}

const QUICK_LABEL: Record<string, string> = { agree: "Go with this", park: "Not now", drop: "Drop it" };

/**
 * "See options" on a question. Most questions have no options (127 of 145 open ones on 15 Oct), so the sheet always
 * works from the recommendation: "Go with this" agrees to it, "Not now" parks the question, "Drop it" drops it. When
 * there are options, each is one row to pick (the suggested one marked quietly). "Say something else…" takes his own
 * words, and one Send sends a pick and/or words. Sending never waits here: the sheet closes, the row says "Sending…"
 * (an option or typed answer is read by the model and can take a minute), then shows the receipt, and ticks itself
 * off only if Ash OS says the question closed.
 */
export function QuestionSheet({ needId, onClose }: { needId: string; onClose: () => void }) {
  const data = hubData();
  const [q, setQ] = useState<HubQuestion | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    data.question?.(needId).then(
      (loaded) => alive && setQ(loaded),
      (e: unknown) => {
        const said = e instanceof Error ? e.message : "";
        // An Ash OS from before the answer calls: say so plainly instead of its error.
        if (alive) setProblem(/unknown hub action/i.test(said) ? "The harness needs its update before it can show this question here." : said || "Couldn't load the question.");
      },
    );
    return () => {
      alive = false;
    };
  }, [data, needId]);

  const send = (answer: HubAnswer) => {
    data.answer?.(needId, answer);
    onClose();
  };
  const canSend = picked !== null || text.trim().length > 0;
  const sendPick = () => canSend && send({ ...(picked !== null ? { choice: picked } : {}), ...(text.trim() ? { text: text.trim() } : {}) });
  const quick = (id: string) => q?.quickAnswers.find((a) => a.id === id);

  return (
    <Sheet label="See options" onClose={onClose}>
      {q ? (
        <>
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 text-[15px] leading-6 text-content" data-hub-question>{q.question}</h1>
            <button type="button" className={QUIET} onClick={onClose} aria-label="Close">
              Close
            </button>
          </div>
          {q.status !== "open" ? (
            <p className="text-[13px] text-content/60">{q.status === "answered" ? "This is already answered." : "This question has expired."}</p>
          ) : null}
          {q.heldAnswer ? (
            <p className="text-[13px] leading-5 text-content/60" data-hub-held>
              Your answer is saved: "{q.heldAnswer}". It is applied as soon as sorting is back.
            </p>
          ) : null}
          {q.recommendation.text ? (
            <div className="flex items-center gap-3 rounded-lg bg-content/5 px-3 py-2.5" data-hub-recommendation>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-content/60">Suggested</div>
                <div className="text-[13px] leading-5 text-content">{q.recommendation.text}</div>
              </div>
              {quick("agree") && q.status === "open" ? (
                <button type="button" className="shrink-0 rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90" data-hub-quick="agree" onClick={() => send({ quick: "agree" })}>
                  {QUICK_LABEL.agree}
                </button>
              ) : null}
            </div>
          ) : null}
          {q.options.length ? (
            <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="Options">
              {q.options.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={picked === i}
                  data-hub-question-option={i}
                  disabled={q.status !== "open"}
                  onClick={() => setPicked(picked === i ? null : i)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-left ${picked === i ? "bg-content/12" : "hover:bg-content/5"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-content">{o.label}</span>
                    {o.detail ? <span className="block text-[13px] leading-5 text-content/60">{o.detail}</span> : null}
                  </span>
                  {q.recommendation.optionIndex === i ? <span className="shrink-0 text-xs text-content/60" data-hub-suggested>Suggested</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          {q.status === "open" ? (
            <>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendPick()}
                placeholder="Say something else…"
                aria-label="Say something else"
                maxLength={4000}
                className="rounded-md bg-content/8 px-2.5 py-1.5 text-[13px] text-content outline-none placeholder:text-content/60 focus:bg-content/12"
              />
              <div className="flex items-center gap-2">
                {quick("park") ? (
                  <button type="button" className={QUIET} data-hub-quick="park" onClick={() => send({ quick: "park" })}>
                    {QUICK_LABEL.park}
                  </button>
                ) : null}
                {quick("drop") ? (
                  <button type="button" className={QUIET} data-hub-quick="drop" onClick={() => send({ quick: "drop" })}>
                    {QUICK_LABEL.drop}
                  </button>
                ) : null}
                <span className="flex-1" />
                <button type="button" className={BTN} disabled={!canSend} onClick={sendPick} data-hub-send>
                  Send
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-[13px] text-content/60" data-hub-sheet-problem>{problem ?? "One moment."}</p>
          <div className="flex justify-end">
            <button type="button" className={QUIET} onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** "Open" on an ask (or "Start" on a gate) with no screen of its own yet: what it is, in full. */
export function DetailSheet({ need, onClose }: { need: Need; onClose: () => void }) {
  return (
    <Sheet label="Details" onClose={onClose}>
      <div className="flex flex-col gap-2" data-hub-detail={need.id}>
        <h1 className="text-[15px] leading-6 text-content">{need.title}</h1>
        {need.why ? <p className="text-[13px] leading-5 text-content/85">{need.why}</p> : null}
        {need.detail ? <p className="whitespace-pre-line text-[13px] leading-5 text-content/60">{need.detail}</p> : null}
      </div>
      <div className="flex justify-end">
        <button type="button" className={QUIET} onClick={onClose}>
          Close
        </button>
      </div>
    </Sheet>
  );
}
