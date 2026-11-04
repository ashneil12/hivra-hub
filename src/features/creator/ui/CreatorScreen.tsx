// WP-34. Settings → Plugins → Creator. Build writes a scratch plugin, Preview shows it in this view only,
// Keep switches it on, Undo rolls that back, Discard removes the scratch folder.

import { useEffect, useRef, useState } from "react";
import { openMonoChat } from "../../hub/model/hubNav";
import { bespokeSrcdoc, SANDBOX } from "../../pages/model/sandbox";
import { beginCreatorBuild, CREATOR_BRIEF_EVENT, CREATOR_DRAFT_EVENT, CREATOR_MONO_ID } from "../model/creatorChat";
import {
  creatorApproveMcp,
  creatorDiscard,
  creatorKeep,
  creatorPreview,
  creatorProbe,
  creatorState,
  creatorUndo,
  errorText,
  isLatest,
  readState,
  statusLine,
  takeLatest,
  type CreatorState,
} from "../model/creator";
import type { ContributionKind } from "../model/draftFor";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";
const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";

const KINDS: { id: ContributionKind; label: string }[] = [
  { id: "skill", label: "Skill" },
  { id: "panel", label: "Panel" },
  { id: "persona", label: "Persona" },
  { id: "mono", label: "Mono" },
  { id: "command", label: "Slash command" },
];

export function CreatorScreen() {
  const [ask, setAsk] = useState("");
  const [kind, setKind] = useState<ContributionKind>("panel");
  const [state, setState] = useState<CreatorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = useRef<CreatorState | null>(null);
  const building = useRef<string | null>(null);

  function apply(next: CreatorState) {
    const current = held.current;
    if (current && current.id === next.id && next.revision < current.revision) return;
    held.current = next;
    setState(next);
  }

  useEffect(() => {
    const onBrief = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (typeof id === "string") building.current = id;
    };
    const onDraft = (event: Event) => {
      const next = readState((event as CustomEvent).detail);
      if (!next) return;
      const current = held.current;
      if (current && current.id !== next.id && building.current !== next.id) return;
      apply(next);
    };
    window.addEventListener(CREATOR_BRIEF_EVENT, onBrief);
    window.addEventListener(CREATOR_DRAFT_EVENT, onDraft);
    return () => {
      window.removeEventListener(CREATOR_BRIEF_EVENT, onBrief);
      window.removeEventListener(CREATOR_DRAFT_EVENT, onDraft);
    };
  }, []);

  function run(work: (current: () => boolean) => Promise<CreatorState>) {
    const token = takeLatest();
    const current = () => isLatest(token);
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const next = await work(current);
        if (!current()) return;
        apply(next);
      } catch (caught) {
        if (!current()) return;
        setError(errorText(caught));
        const id = held.current?.id;
        if (!id) return;
        try {
          const fresh = await creatorState(id);
          if (current()) apply(fresh);
        } catch {
          // The note above is the failure. The last state we trusted stays.
        }
      } finally {
        if (current()) setBusy(false);
      }
    })();
  }

  const phase = state?.phase ?? "";
  const panel = state?.panel;

  return (
    <div data-creator data-phase={phase} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-[13px] text-content/70">
        What to build
        <select
          aria-label="What to build"
          value={kind}
          onChange={(event) => setKind(event.target.value as ContributionKind)}
          className="rounded-md border border-stroke bg-transparent px-2 py-1 text-content"
        >
          {KINDS.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-content/70">
        What should it do?
        <textarea
          aria-label="What should it do?"
          value={ask}
          onChange={(event) => setAsk(event.target.value)}
          rows={3}
          className="w-full rounded-md border border-stroke bg-transparent px-3 py-1.5 text-[13px] text-content outline-none"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          onClick={() => {
            const chosen = kind;
            const text = ask;
            run(async (current) => {
              const started = await beginCreatorBuild({ kind: chosen, ask: text });
              if (!current()) return started.state;
              const heldNow = held.current;
              if (heldNow && heldNow.id === started.state.id && heldNow.revision > started.state.revision) return heldNow;
              return started.state;
            });
          }}
        >
          Build
        </button>
        {phase === "drafted" ? (
          <button type="button" className={BTN} disabled={busy} onClick={() => run(() => creatorPreview(state!.id, state!.revision))}>
            Preview
          </button>
        ) : null}
        {phase === "previewed" || phase === "undone" ? (
          <button type="button" className={BTN} disabled={busy} onClick={() => run(() => creatorKeep(state!.id, state!.revision))}>
            Keep
          </button>
        ) : null}
        {phase === "kept" ? (
          <button type="button" className={BTN} disabled={busy} onClick={() => run(() => creatorUndo(state!.id, state!.revision))}>
            Undo
          </button>
        ) : null}
        {state && phase !== "discarded" && phase !== "kept" ? (
          <button type="button" className={BTN} disabled={busy} onClick={() => run(() => creatorDiscard(state.id, state.revision))}>
            Discard
          </button>
        ) : null}
        {state?.mcpWaiting ? (
          <button type="button" className={BTN} disabled={busy} onClick={() => run(() => creatorApproveMcp(state.id, state.revision))}>
            Allow this server
          </button>
        ) : null}
        {state && state.mcpApproved && state.mcpServers.length > 0 && phase !== "discarded" ? (
          <button type="button" className={BTN} disabled={busy} onClick={() => run(() => creatorProbe(state.id, state.revision))}>
            Test the server
          </button>
        ) : null}
        {state ? (
          <button type="button" className={BTN} onClick={() => openMonoChat(CREATOR_MONO_ID)}>
            Open the Creator chat
          </button>
        ) : null}
      </div>
      {state?.mcpWaiting ? (
        <p className="text-[13px] text-content/70">This server doesn't run until you allow it.</p>
      ) : null}
      {state?.scriptWaiting ? (
        <p className="text-[13px] text-content/70">It wants to run a setup step, so it is waiting for your OK.</p>
      ) : null}
      <p data-creator-status className="text-[13px] text-content/70">{state ? statusLine(state.phase) : "Started."}</p>
      {error ? <p data-creator-error className="text-[13px] text-content/70">{error}</p> : null}
      {panel ? (
        <iframe
          title={panel.title}
          sandbox={SANDBOX}
          srcDoc={bespokeSrcdoc({ html: panel.html, css: panel.css, js: panel.js }, {})}
          className="min-h-40 w-full rounded-md border border-stroke bg-transparent"
        />
      ) : null}
    </div>
  );
}
