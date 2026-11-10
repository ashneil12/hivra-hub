import type { Lineage, LineageChild, LineageStatus } from "../model/subagentLineage";

const STATUS_LABEL: Record<LineageStatus, string> = {
  running: "Working",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

function sentence(label: string): string {
  if (!label) return label;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Native CLI children on the parent thread. This is not the first-mate crew.
 * Each child's own steps are already in its row in the transcript, so the list does not link anywhere.
 */
export function LineageList({ lineage }: { lineage: Lineage }) {
  if (lineage.reported && lineage.children.length === 0) return null;
  if (!lineage.reported) {
    return (
      <section data-lineage className="px-4 py-2 font-sans text-sm text-content/50">
        <h2 className="text-[12px] text-content/40">Subagents</h2>
        <p data-lineage-unreported>{sentence(lineage.label)}</p>
      </section>
    );
  }
  return (
    <section data-lineage className="min-w-0 px-4 py-2 font-sans">
      <h2 className="text-[12px] text-content/40">Subagents</h2>
      <ul className="flex min-w-0 flex-col">
        {lineage.children.map((child) => (
          <LineageRow key={child.id} child={child} />
        ))}
      </ul>
    </section>
  );
}

function LineageRow({ child }: { child: LineageChild }) {
  const outcome = child.error ?? child.result;
  return (
    <li data-lineage-child={child.id} className="flex min-w-0 flex-col gap-1 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span data-lineage-name className="min-w-0 flex-1 truncate text-sm text-content/80">
          {child.name}
        </span>
        <span className="flex shrink-0 items-baseline gap-2 text-[12px] text-content/40">
          {child.role ? <span data-lineage-role>{child.role}</span> : null}
          {child.model ? <span data-lineage-model>{child.model}</span> : null}
          <span data-lineage-status={child.status}>{STATUS_LABEL[child.status]}</span>
        </span>
      </div>
      {outcome ? (
        <p
          data-lineage-outcome={child.error ? "error" : "result"}
          className={`whitespace-pre-wrap break-words text-[12px] ${child.error ? "text-red-400" : "text-content/60"}`}
        >
          {outcome}
        </p>
      ) : null}
    </li>
  );
}
