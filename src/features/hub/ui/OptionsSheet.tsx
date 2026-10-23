import { useEffect, useState } from "react";
import { hubData } from "../model/hubData";
import type { JobOptions } from "../model/types";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-60";

/**
 * "See options" on a job the Lead gave up on: what was tried, then Try again tonight, Try it a different way (with a
 * hint), Pause this job, Drop it. Ash's pick goes to Ash OS; the row ticks itself off when it lands.
 */
export function OptionsSheet({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const data = hubData();
  const [sheet, setSheet] = useState<JobOptions | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    data.jobOptions?.(jobId).then(
      (s) => alive && setSheet(s),
      (e: unknown) => alive && setProblem(e instanceof Error ? e.message : "Couldn't load the options."),
    );
    return () => {
      alive = false;
    };
  }, [data, jobId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = async (option: string, text?: string) => {
    if (!data.jobAct) return;
    setBusy(true);
    setProblem(null);
    try {
      await data.jobAct(jobId, option, text);
      onClose();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't go through.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-background-base/75" data-hub-options-sheet onClick={onClose}>
      <div role="dialog" aria-label="See options" onClick={(e) => e.stopPropagation()} className="flex w-[520px] max-w-[calc(100vw-48px)] flex-col gap-4 rounded-2xl border border-content/7 dialog-glass p-6 shadow-2xl">
        {sheet ? (
          <>
            <div className="flex flex-col gap-1">
              <h1 className="text-[15px] text-content">{sheet.title}</h1>
              <p className="text-[13px] leading-5 text-content/60">{sheet.why}</p>
            </div>
            <div className="flex flex-col gap-0.5">
              {sheet.options.map((o) => (
                <div key={o.id} className="flex flex-col gap-2 rounded-lg px-3 py-2.5 hover:bg-content/5" data-hub-option={o.id}>
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-content">{o.label}</div>
                      <div className="text-[13px] leading-5 text-content/60">{o.note}</div>
                    </div>
                    {o.needsText && typing !== o.id ? (
                      <button type="button" className={BTN} disabled={busy} onClick={() => setTyping(o.id)}>
                        Write a hint
                      </button>
                    ) : o.needsText ? null : (
                      <button type="button" className={BTN} disabled={busy} onClick={() => void pick(o.id)}>
                        Choose
                      </button>
                    )}
                  </div>
                  {o.needsText && typing === o.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={hint}
                        onChange={(e) => setHint(e.target.value)}
                        placeholder={o.placeholder ?? "A hint"}
                        aria-label={o.placeholder ?? "A hint"}
                        onKeyDown={(e) => e.key === "Enter" && hint.trim() && void pick(o.id, hint.trim())}
                        className="min-w-0 flex-1 rounded-md bg-content/8 px-2.5 py-1.5 text-[13px] text-content outline-none placeholder:text-content/60 focus:bg-content/12"
                      />
                      <button type="button" className={BTN} disabled={busy || !hint.trim()} onClick={() => void pick(o.id, hint.trim())}>
                        Send
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : problem ? null : (
          <p className="text-[13px] text-content/60">One moment.</p>
        )}
        {problem ? <p className="text-[13px] text-content/60" data-hub-options-problem>{problem}</p> : null}
        <div className="flex justify-end">
          <button type="button" className="rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content" onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
