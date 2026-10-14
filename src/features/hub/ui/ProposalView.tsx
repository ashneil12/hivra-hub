import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft, Check } from "../../../shared/ui/icons";
import {
  applyProposal,
  dismissProposal,
  getProposal,
  undoProposal,
  useProposalsVersion,
  type PreviewSketch,
} from "../model/proposals";
import { hubData } from "../model/hubData";
import { setHubSelection } from "../model/hubNav";

const QUIET = "rounded-md px-2.5 py-1 text-xs text-content/60 hover:bg-content/8 hover:text-content";

/** Calm preview of a proposed self-change: before/after, why, rules, Apply / Not now. */
export function ProposalView({ id }: { id: string }) {
  useProposalsVersion();
  const p = getProposal(id);
  const project = p ? hubData().listProjects().find((x) => x.id === p.projectId)?.name : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-proposal={id}>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        <button
          type="button"
          title="Back"
          aria-label="Back"
          onClick={() => setHubSelection({ project: p?.projectId ?? "today", item: "inbox" })}
          className="grid size-6 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </button>
        <span className="min-w-0 truncate text-[13px] text-content">Proposed change{project ? ` · ${project}` : ""}</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!p ? (
          <div className="grid h-full place-items-center text-[13px] text-content/60">This proposal is no longer here.</div>
        ) : (
          <div className="mx-auto flex max-w-[820px] flex-col gap-6 px-8 py-8">
            <div>
              <div className="text-[15px] text-content">{p.title}</div>
              <div className="text-[13px] leading-5 text-content/60">
                Proposed by {p.by}. {p.why}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Sketch label="Now" sketch={p.before} />
              <Sketch label="After" sketch={p.after} />
            </div>
            <section className="flex flex-col gap-1">
              <h2 className="text-xs text-content/60">Checked against the design rules</h2>
              {p.checked.map((r) => (
                <div key={r} className="flex items-center gap-2 text-[13px] text-content/85">
                  <Check className="size-3.5 text-content/60" strokeWidth={2} /> {r}
                </div>
              ))}
            </section>
            {p.status === "pending" ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-hub-apply
                    onClick={() => applyProposal(p.id)}
                    className="rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90"
                  >
                    Apply
                  </button>
                  <button type="button" data-hub-not-now onClick={() => dismissProposal(p.id)} className={QUIET}>
                    Not now
                  </button>
                </div>
            ) : p.status === "applied" ? (
              <div className="flex items-center gap-1 text-[13px] text-content/60" data-hub-applied>
                Applied ·
                <button type="button" data-hub-undo onClick={() => undoProposal(p.id)} className="rounded px-1 text-content/85 underline-offset-2 hover:underline">
                  Undo
                </button>
                <span className="pl-2">Past changes are in Settings, under Changes.</span>
              </div>
            ) : (
              <div className="text-[13px] text-content/60">{p.status === "undone" ? "Undone." : "Not now. It's no longer waiting on you."}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Sketch({ label, sketch }: { label: string; sketch: PreviewSketch }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-content/60">{label}</div>
      <div className="flex min-h-[180px] flex-col gap-1 rounded-lg bg-content/5 p-3">
        <div className="pb-1 text-xs text-content/60">{sketch.heading}</div>
        {sketch.rows.map((r) => (
          <div key={r.text} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${r.isNew || r.moved ? "bg-content/10 text-content" : "text-content/75"}`}>
            <span className="min-w-0 flex-1 truncate">{r.text}</span>
            {r.isNew ? <span className="text-[11px] text-content/60">New</span> : null}
            {r.moved ? <span className="text-[11px] text-content/60">Moved</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
