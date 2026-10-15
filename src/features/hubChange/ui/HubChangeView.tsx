import { useState } from "react";
import { ArrowUp, Undo2 } from "../../../shared/ui/icons";
import { applyChange, discardChange, FLOW_LABEL, HUB_CANT, requestChange, SEATED_ONLY, type ChangeFlow, type ChangeResult, type ChangeSide } from "../model/hubChange";

/** Level 2: a seated Mono asks Claude Code for a preview build; Now beside Preview; Apply or Discard; Undo in Bot changes. */
const card = "rounded-xl bg-surface ring-1 ring-surface-ring";
const btn = "rounded-md px-3 py-1.5 text-[12px] transition-colors";
const quietBtn = `${btn} text-content/70 hover:bg-surface-raised hover:text-content`;
const primaryBtn = `${btn} bg-content/12 text-content hover:bg-content/18`;
const ASKER_ID = "projects-manager";
const PLACEHOLDER: Record<ChangeFlow, string> = {
  hub: "Ask for a change to the hub, like “group my chats by week”…",
  today: "Ask for a change to Today, like “add a builds-this-week count”…",
  connect: "Say what to connect, like “hook the EXO page up to our bug tracker”…",
};

function Side({ side }: { side: ChangeSide }) {
  if (side.image) return <img src={side.image} alt="" className="w-full rounded-lg ring-1 ring-surface-ring" />;
  return (
    <div className="flex min-h-[220px] flex-col gap-3 rounded-lg bg-background-base p-3 ring-1 ring-surface-ring">
      {side.sections.map((s) => (
        <div key={s.title}>
          <div className="pb-1 text-[11px] uppercase tracking-wide text-content/60">{s.title}</div>
          {s.rows.map((r) => <div key={r} className="truncate rounded-md px-2 py-1.5 text-[13px] text-content/85">{r}</div>)}
        </div>
      ))}
    </div>
  );
}

/** The Not connected yet card says only this, with Back. */
export const NOT_ON_COPY = "This isn't switched on yet. Once it is, you'll see your hub next to the preview.";

export function HubChangeContent({ flow, projectId }: { flow: ChangeFlow; projectId: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ prompt: string; result?: ChangeResult; applied?: boolean }>();
  const ask = (prompt: string) => {
    setState({ prompt });
    void requestChange({ flow, projectId, monoId: ASKER_ID, prompt }).then((result) => setState({ prompt, result }));
  };
  const r = state?.result;
  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-6" data-hub-change={flow}>
      <h1 className="text-[17px] font-medium text-content">{FLOW_LABEL[flow]}</h1>
      <p className="mt-1 text-[12px] text-content/60" data-hub-change-cant>{HUB_CANT}</p>
      <p className="mb-4 mt-1 text-[12px] text-content/60">{SEATED_ONLY}</p>
      {!state ? (
        <form className={`${card} flex items-center gap-2 px-3 py-2`} onSubmit={(e) => { e.preventDefault(); if (text.trim()) ask(text.trim()); }}>
          <input aria-label={`Ask for: ${FLOW_LABEL[flow]}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={PLACEHOLDER[flow]}
            className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-content outline-none placeholder:text-content/60" />
          <button type="submit" aria-label="Ask Projects Manager" disabled={!text.trim()} className="grid size-7 place-items-center rounded-full bg-content/12 text-content hover:bg-content/18 disabled:opacity-40">
            <ArrowUp className="size-3.5" strokeWidth={2} />
          </button>
        </form>
      ) : !r ? (
        <div className={`${card} flex items-center gap-3 p-5 text-[13px] text-content/80`} role="status">
          <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-content/20 border-t-content/70" />
          Projects Manager asked Claude Code for a preview build…
        </div>
      ) : r.status === "not-connected" ? (
        <div className={`${card} p-5`} data-hub-change-not-connected>
          <div className="text-[14px] text-content">Not connected yet</div>
          <p className="mt-1 text-[13px] leading-5 text-content/70">{NOT_ON_COPY}</p>
          <div className="mt-3 flex gap-2"><button type="button" className={quietBtn} onClick={() => setState(undefined)}>Back</button></div>
        </div>
      ) : r.status !== "ready" ? (
        <div className="rounded-lg px-3 py-2.5" data-hub-change-turned-down>
          <div className="text-[13px] text-content">Sent back to Projects Manager</div>
          <div className="text-[13px] leading-5 text-content/60">Turned down automatically: {r.reason}</div>
          <button type="button" className={`${quietBtn} mt-2`} onClick={() => setState(undefined)}>Back</button>
        </div>
      ) : state.applied ? (
        <div className={`${card} flex items-center gap-2 p-4 text-[13px] text-content/85`} role="status" data-hub-change-applied>
          <Undo2 className="size-3.5 text-content/60" />Applied: {r.preview.title}. Undo it any time in Settings → Changes → Bot changes.
          <button type="button" className={`${quietBtn} ml-auto`} onClick={() => { setState(undefined); setText(""); }}>Ask for another</button>
        </div>
      ) : (
        <div data-hub-change-preview>
          <div className="mb-3 text-[12px] text-content/70">“{state.prompt}” · {r.preview.by} asked Claude Code</div>
          <div className="grid grid-cols-2 gap-5">
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wide text-content/60">Now</div>
              <div className="p-4"><Side side={r.preview.now} /></div>
            </div>
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wide text-content/60">Preview</div>
              <div className="relative rounded-xl border border-dashed border-content/30 p-4">
                <div aria-hidden className="pointer-events-none absolute inset-0 grid select-none place-items-center overflow-hidden rounded-xl"><span className="-rotate-12 text-[64px] font-semibold tracking-widest text-content/[0.05]">Preview</span></div>
                <div className="relative"><Side side={r.preview.preview} /></div>
              </div>
            </div>
          </div>
          <div className="mt-5 flex items-center gap-3 rounded-xl border border-dashed border-content/20 bg-background-base/90 px-5 py-3">
            <span className="text-[12px] text-content/70">This is a preview build. Your live hub hasn't changed.</span>
            <span className="ml-auto" />
            <button type="button" className={quietBtn} onClick={() => { void discardChange(r.preview); setState(undefined); }}>Discard</button>
            <button type="button" className={primaryBtn} data-hub-change-apply onClick={() => void applyChange(flow, r.preview).then((done) => setState(done.status === "applied" ? { ...state, applied: true } : { ...state, result: done }))}>Apply</button>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-content/60"><Undo2 className="size-3" />After Apply, you can Undo it any time in Bot changes.</div>
        </div>
      )}
    </div>
  );
}
