import { useEffect, useState } from "react";
import { hubData } from "../model/hubData";
import type { HubQuestion, Need } from "../model/types";

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

/**
 * "See options" on a question: the question in plain words, each option one row to pick (the suggested one marked
 * quietly), "Say something else…" for his own words, and one Send. After sending, the receipt shows briefly and the
 * Needs row ticks itself off.
 */
export function QuestionSheet({ questionId, onClose }: { questionId: string; onClose: () => void }) {
  const data = hubData();
  const [q, setQ] = useState<HubQuestion | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    data.question?.(questionId).then(
      (loaded) => alive && setQ(loaded),
      (e: unknown) => alive && setProblem(e instanceof Error ? e.message : "Couldn't load the question."),
    );
    return () => {
      alive = false;
    };
  }, [data, questionId]);
  useEffect(() => {
    if (!receipt) return;
    const t = setTimeout(onClose, 2500);
    return () => clearTimeout(t);
  }, [receipt, onClose]);

  const canSend = !busy && !receipt && (picked !== null || text.trim().length > 0);
  const send = async () => {
    if (!canSend || !data.answer) return;
    setBusy(true);
    setProblem(null);
    try {
      setReceipt(await data.answer(questionId, { ...(picked !== null ? { choice: picked } : {}), ...(text.trim() ? { text: text.trim() } : {}) }));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't go through.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet label="See options" onClose={onClose}>
      {q ? (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="text-[15px] leading-6 text-content" data-hub-question>{q.question}</h1>
            {q.recommendation ? <p className="text-[13px] leading-5 text-content/60">{q.recommendation}</p> : null}
          </div>
          <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="Options">
            {q.options.map((o, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={picked === i}
                data-hub-question-option={i}
                disabled={busy || !!receipt}
                onClick={() => setPicked(picked === i ? null : i)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-left ${picked === i ? "bg-content/12" : "hover:bg-content/5"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-content">{o.label}</span>
                  {o.detail ? <span className="block text-[13px] leading-5 text-content/60">{o.detail}</span> : null}
                </span>
                {q.recommendedIndex === i ? <span className="shrink-0 text-xs text-content/60" data-hub-suggested>Suggested</span> : null}
              </button>
            ))}
          </div>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void send()}
            disabled={busy || !!receipt}
            placeholder="Say something else…"
            aria-label="Say something else"
            className="rounded-md bg-content/8 px-2.5 py-1.5 text-[13px] text-content outline-none placeholder:text-content/60 focus:bg-content/12"
          />
          {receipt ? <p className="text-[13px] text-content/85" data-hub-receipt>{receipt}</p> : null}
          {problem ? <p className="text-[13px] text-content/60" data-hub-sheet-problem>{problem}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={QUIET} onClick={onClose}>
              Not now
            </button>
            <button type="button" className={BTN} disabled={!canSend} onClick={() => void send()} data-hub-send>
              Send
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[13px] text-content/60">{problem ?? "One moment."}</p>
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
