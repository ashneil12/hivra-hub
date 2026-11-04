// WP-34. Settings → Plugins → Creator. Build writes a scratch plugin, Preview shows it in this view only,
// Keep switches it on, Undo rolls that back, Discard removes the scratch folder.

import { useRef, useState } from "react";
import { bespokeSrcdoc, SANDBOX } from "../../pages/model/sandbox";
import {
  creatorApproveMcp,
  creatorDiscard,
  creatorDraft,
  creatorKeep,
  creatorPreview,
  creatorStart,
  creatorState,
  creatorUndo,
  errorText,
  isLatest,
  statusLine,
  takeLatest,
  type CreatorState,
} from "../model/creator";
import { draftFor, type ContributionKind } from "../model/draftFor";

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

  function apply(next: CreatorState) {
    held.current = next;
    setState(next);
  }

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
              const started = await creatorStart(chosen);
              if (!current()) return started;
              apply(started);
              return creatorDraft(started.id, started.revision, draftFor(chosen, text, started.id));
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
