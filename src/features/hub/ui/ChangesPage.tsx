import { pastChanges, undoProposal, useProposalsVersion } from "../model/proposals";
import { hubData } from "../model/hubData";

/** Settings → Changes: every self-change that went live, each with Undo. */
export function ChangesPage() {
  useProposalsVersion();
  const list = pastChanges();
  const name = (id: string) => hubData().listProjects().find((p) => p.id === id)?.name ?? id;
  if (!list.length) return <p className="text-[13px] text-content/60">No changes yet. When you apply a proposed change, it shows up here with Undo.</p>;
  return (
    <div className="flex flex-col gap-0.5" data-hub-changes>
      {list.map((p) => (
        <div key={p.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-content/5">
          <div className="min-w-0 flex-1">
            <div className={`truncate text-[13px] ${p.status === "undone" ? "text-content/60" : "text-content"}`}>{p.title}</div>
            <div className="truncate text-[13px] text-content/60">
              {name(p.projectId)} · by {p.by} · {p.appliedAt}
            </div>
          </div>
          {p.status === "undone" ? (
            <span className="text-xs text-content/60">Undone</span>
          ) : (
            <button type="button" data-hub-change-undo={p.id} onClick={() => undoProposal(p.id)}
              className="shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12">
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
