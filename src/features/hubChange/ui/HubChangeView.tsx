import { useEffect, useState } from "react";
import { setTodayPreviewShown, settleTodayChatPreview, useTodayChatPreview } from "../../selfBuild/model/todayChat";
import { ArrowUp, Undo2 } from "../../../shared/ui/icons";
import { hubData, sinceLabel, useHubDataVersion } from "../../hub/model/hubData";
import type { HubChangeRecord } from "../../hub/model/types";
import { listMonos } from "../../monos/model/mono";
import {
  applyChange, changeLine, discardChange, FLOW_LABEL, HUB_CANT, redoChange, requestChange, SEATED_ONLY, undoChange, type ChangeFlow, type ChangeResult,
  type ChangeSide,
} from "../model/hubChange";
import { APP_CHANGE_NOTE, APP_CHANGE_WHY, openHubLead, sendToHubLead } from "../model/appChange";

/**
 * Level 2: a seated Mono builds the change as a preview; Now beside Preview; Apply or Discard. Ash OS keeps every change
 * (its history, under the ask box) with Undo and Redo, also in Bot changes and, for Today, on Today itself.
 */
const card = "rounded-xl bg-surface ring-1 ring-surface-ring";
const btn = "rounded-md px-3 py-1.5 text-[12px] transition-colors";
const quietBtn = `${btn} text-content/70 hover:bg-surface-raised hover:text-content`;
const primaryBtn = `${btn} bg-content/12 text-content hover:bg-content/18`;
const PLACEHOLDER: Record<ChangeFlow, string> = {
  hub: "Ask for a change to the app, like “put Hivra first in the sidebar”…",
  today: "Ask for a change to Today, like “put my sign-ups hub on Today”…",
  connect: "Say what to connect, like “hook the EXO hub up to our bug tracker”…",
};
function Side({ side }: { side: ChangeSide }) {
  if (side.image) return <img src={side.image} alt="" className="w-full rounded-lg ring-1 ring-surface-ring" />;
  return (
    <div className="flex min-h-[220px] flex-col gap-3 rounded-lg bg-background-base p-3 ring-1 ring-surface-ring">
      {side.sections.map((s) => (
        <div key={s.title}>
          <div className="pb-1 text-[11px] uppercase tracking-wide text-content/60">{s.title}</div>
          {s.rows.map((r, i) => <div key={`${i}-${r}`} className="truncate rounded-md px-2 py-1.5 text-[13px] text-content/85">{r}</div>)}
        </div>
      ))}
    </div>
  );
}

/** The Not connected yet card says only this, with Back. */
export const NOT_ON_COPY = "This isn't switched on yet. Once it is, you'll see your app next to the preview.";

const STATE_WORD: Record<HubChangeRecord["state"], string> = { preview: "Preview", applied: "Applied", undone: "Undone", discarded: "Thrown away" };

/** One change in the history: what it did, who and when, and Undo (applied) or Redo (undone). */
export function ChangeRow({ change, compact }: { change: HubChangeRecord; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const step = (run: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    void run().then(() => setBusy(false), (e: Error) => { setBusy(false); setProblem(e.message); });
  };
  const at = change.undoneAt ?? change.appliedAt ?? change.createdAt;
  const refused = [...change.log].reverse().find((l) => l.what.endsWith("refused"));
  return (
    <div className="rounded-md px-2 py-2 hover:bg-content/5" data-hub-change-row={change.previewId} data-hub-change-state={change.state}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[13px] ${change.state === "applied" ? "text-content" : "text-content/60"}`}>{compact ? `${changeLine(change)}${change.state === "undone" ? " (undone)" : ""}` : change.title}</div>
          {compact ? null : (
            <div className="truncate text-[12px] text-content/60">
              {change.by} · {STATE_WORD[change.state]}{at ? ` · ${sinceLabel(at).replace(/^Since /, "")}` : ""}{change.prompt ? ` · “${change.prompt}”` : ""}
            </div>
          )}
        </div>
        {change.state === "applied" ? (
          <button type="button" disabled={busy} data-hub-change-row-undo aria-label={`Undo: ${changeLine(change)}`} onClick={() => step(() => undoChange(change.previewId))} className={`${quietBtn} flex items-center gap-1.5 disabled:opacity-50`}>
            <Undo2 className="size-3.5 text-content/60" />Undo
          </button>
        ) : change.state === "undone" ? (
          <button type="button" disabled={busy} data-hub-change-row-redo aria-label={`Redo: ${changeLine(change)}`} onClick={() => step(() => redoChange(change.previewId))} className={`${quietBtn} disabled:opacity-50`}>Redo</button>
        ) : null}
      </div>
      {problem ? <div className="mt-0.5 text-[12px] leading-5 text-content/70" role="alert" data-hub-change-row-problem>{problem}</div> : null}
      {!problem && refused?.note && !compact ? <div className="mt-0.5 text-[12px] leading-5 text-content/60">{refused.note}</div> : null}
    </div>
  );
}

/** Ash OS's history for this flow, newest first. */
function History({ flow }: { flow: ChangeFlow }) {
  useHubDataVersion();
  const changes = (hubData().listChanges?.() ?? []).filter((c) => c.flow === flow && c.state !== "preview");
  if (!changes.length) return null;
  return (
    <section className="mt-8" data-hub-change-history={flow}>
      <h2 className="mb-1 px-2 text-[11px] uppercase tracking-wide text-content/60">Changes</h2>
      <div className="flex flex-col">
        {changes.slice(0, 20).map((c) => <ChangeRow key={c.previewId} change={c} />)}
      </div>
    </section>
  );
}

export function HubChangeContent({ flow, projectId }: { flow: ChangeFlow; projectId: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ prompt: string; result?: ChangeResult; applied?: boolean; undoProblem?: string; lead?: { sending?: boolean; sent?: string; problem?: string } }>();
  // Who builds it: any seated Mono (never a temporary worker). The project's lead is preferred by the caller; otherwise the first one.
  const seated = listMonos().map((m) => ({ id: m.id, name: m.name ?? m.id }));
  const [picked, setPicked] = useState<string>();
  const askerId = picked && seated.some((m) => m.id === picked) ? picked : seated[0]?.id ?? "";
  const asker = seated.find((m) => m.id === askerId)?.name ?? "A Mono";
  const ask = (prompt: string) => {
    setState({ prompt });
    void requestChange({ flow, projectId, monoId: askerId, prompt }).then((result) => setState({ prompt, result }));
  };
  const reset = () => { setState(undefined); setText(""); };
  // A Today change a Mono built from its chat (today_change) shows here, the same Now | Preview, Apply and Discard.
  const chat = useTodayChatPreview();
  const fromChat = chat?.flow === flow ? chat : undefined;
  useEffect(() => {
    if (fromChat) setState({ prompt: fromChat.prompt, result: { status: "ready", preview: fromChat.preview } });
  }, [fromChat?.previewId]);
  const onChat = chat?.flow === flow && state?.result?.status === "ready" && !state.applied && chat?.previewId === state.result.preview.previewId ? chat.previewId : undefined;
  useEffect(() => {
    setTodayPreviewShown(onChat);
    return () => setTodayPreviewShown(undefined);
  }, [onChat]);
  const r = state?.result;
  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-6" data-hub-change={flow}>
      <h1 className="text-[17px] font-medium text-content">{FLOW_LABEL[flow]}</h1>
      <p className="mt-1 text-[12px] text-content/60" data-hub-change-cant>{HUB_CANT}</p>
      <p className={`${flow === "connect" ? "mb-4 " : ""}mt-1 text-[12px] text-content/60`}>{SEATED_ONLY}</p>
      {flow === "connect" ? null : <p className="mb-4 mt-1 text-[12px] text-content/60" data-hub-change-app-note>{APP_CHANGE_NOTE}</p>}
      {!state ? (
        <form className={`${card} flex items-center gap-2 px-3 py-2`} onSubmit={(e) => { e.preventDefault(); if (text.trim()) ask(text.trim()); }}>
          <input aria-label={`Ask for: ${FLOW_LABEL[flow]}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={PLACEHOLDER[flow]}
            className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-content outline-none placeholder:text-content/60" />
          {seated.length > 1 ? (
            <select aria-label="Mono that builds it" data-hub-change-mono value={askerId} onChange={(e) => setPicked(e.target.value)}
              className="max-w-[160px] shrink-0 truncate rounded-md bg-surface-raised px-2 py-1 text-[12px] text-content outline-none">
              {seated.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          ) : null}
          <button type="submit" aria-label={`Ask ${asker}`} disabled={!text.trim()} className="grid size-7 place-items-center rounded-full bg-content/12 text-content hover:bg-content/18 disabled:opacity-40">
            <ArrowUp className="size-3.5" strokeWidth={2} />
          </button>
        </form>
      ) : !r ? (
        <div className={`${card} flex items-center gap-3 p-5 text-[13px] text-content/80`} role="status">
          <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-content/20 border-t-content/70" />
          {asker} is building a preview…
        </div>
      ) : r.status === "building" ? (
        <div className={`${card} p-5`} data-hub-change-still-building>
          <div className="flex items-center gap-3 text-[13px] text-content/80" role="status">
            <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-content/20 border-t-content/70" />
            <span className="min-w-0 flex-1 leading-5">{r.reason}</span>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className={quietBtn} onClick={reset}>Back</button>
            <button type="button" className={primaryBtn} data-hub-change-try-again onClick={() => ask(state.prompt)}>Try again</button>
          </div>
        </div>
      ) : r.status === "app-change" ? (
        <div className={`${card} p-5`} data-hub-change-app-change>
          <div className="text-[14px] text-content">This changes the app itself</div>
          <p className="mt-1 text-[13px] leading-5 text-content/70">{r.reason}</p>
          <p className="mt-2 text-[13px] leading-5 text-content/70">{APP_CHANGE_WHY}</p>
          {state.lead?.sent ? (
            <div className="mt-3 flex items-center gap-2" role="status" data-hub-change-sent-lead>
              <span className="min-w-0 flex-1 text-[13px] text-content/85">Sent to {state.lead.sent}. It shows you a copy of the app to try before anything changes.</span>
              <button type="button" className={quietBtn} onClick={openHubLead}>Open the chat</button>
              <button type="button" className={quietBtn} onClick={reset}>Ask for another</button>
            </div>
          ) : (
            <>
              {state.lead?.problem ? <div className="mt-2 text-[12px] text-content/70" role="alert">{state.lead.problem}</div> : null}
              <div className="mt-3 flex gap-2">
                <button type="button" className={quietBtn} onClick={() => setState(undefined)}>Back</button>
                <button type="button" className={primaryBtn} data-hub-change-send-lead disabled={!!state.lead?.sending}
                  onClick={() => {
                    setState({ ...state, lead: { sending: true } });
                    void sendToHubLead(state.prompt).then((out) => setState((now) => now && { ...now, lead: out.ok ? { sent: out.lead } : { problem: out.reason } }));
                  }}>Send to MonoCode Hub lead</button>
              </div>
            </>
          )}
        </div>
      ) : r.status === "not-connected" ? (
        <div className={`${card} p-5`} data-hub-change-not-connected>
          <div className="text-[14px] text-content">Not connected yet</div>
          <p className="mt-1 text-[13px] leading-5 text-content/70">{NOT_ON_COPY}</p>
          <div className="mt-3 flex gap-2"><button type="button" className={quietBtn} onClick={() => setState(undefined)}>Back</button></div>
        </div>
      ) : r.status !== "ready" ? (
        <div className="rounded-lg px-3 py-2.5" data-hub-change-turned-down>
          <div className="text-[13px] text-content">{r.status === "turned-down" ? `Sent back to ${asker}` : "That didn't work"}</div>
          <div className="text-[13px] leading-5 text-content/60">{r.status === "turned-down" ? "Turned down automatically: " : ""}{r.reason}</div>
          <div className="mt-2 flex gap-2">
            <button type="button" className={quietBtn} onClick={() => setState(undefined)}>Back</button>
            {r.status === "error" ? <button type="button" className={primaryBtn} onClick={() => ask(state.prompt)}>Try again</button> : null}
          </div>
        </div>
      ) : state.applied ? (
        <div className={`${card} p-4 text-[13px] text-content/85`} role="status" data-hub-change-applied>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">Applied: {r.preview.title}.</span>
            <button type="button" data-hub-change-undo aria-label={`Undo: ${r.preview.title}`} className={`${quietBtn} flex items-center gap-1.5`}
              onClick={() => void undoChange(r.preview.previewId).then(reset, (e: Error) => setState({ ...state, undoProblem: e.message }))}>
              <Undo2 className="size-3.5 text-content/60" />Undo
            </button>
            <button type="button" className={quietBtn} onClick={reset}>Ask for another</button>
          </div>
          {state.undoProblem ? <div className="mt-1 text-[12px] text-content/70" role="alert">{state.undoProblem}</div> : null}
        </div>
      ) : (
        <div data-hub-change-preview>
          <div className="mb-3 text-[12px] text-content/70">“{state.prompt}” · {r.preview.by} built this preview</div>
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
            <span className="text-[12px] text-content/70">This is a preview build. Your live app hasn't changed.</span>
            <span className="ml-auto" />
            <button type="button" className={quietBtn} onClick={() => { settleTodayChatPreview(r.preview.previewId); void discardChange(r.preview); setState(undefined); }}>Discard</button>
            <button type="button" className={primaryBtn} data-hub-change-apply onClick={() => void applyChange(flow, r.preview).then((done) => { if (done.status === "applied") settleTodayChatPreview(r.preview.previewId); setState(done.status === "applied" ? { ...state, applied: true } : { ...state, result: done }); })}>Apply</button>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-content/60"><Undo2 className="size-3" />After Apply, you can Undo it here, on Today, or in Bot changes.</div>
        </div>
      )}
      <History flow={flow} />
    </div>
  );
}
