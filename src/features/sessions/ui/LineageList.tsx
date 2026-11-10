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
 * A child opens only when Hivra already stored its transcript.
 */
export function LineageList({
  lineage,
  onOpenTranscript,
}: {
  lineage: Lineage;
  onOpenTranscript?: (sessionId: string) => void;
}) {
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
          <LineageRow key={child.id} child={child} onOpenTranscript={onOpenTranscript} />
        ))}
      </ul>
    </section>
  );
}

function LineageRow({
  child,
  onOpenTranscript,
}: {
  child: LineageChild;
  onOpenTranscript?: (sessionId: string) => void;
}) {
  const transcript = child.transcriptSessionId;
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
      {transcript && onOpenTranscript ? (
        <button
          type="button"
          className="self-start text-[12px] text-content/70 underline-offset-2 hover:underline"
          onClick={() => onOpenTranscript(transcript)}
        >
          Open the transcript
        </button>
      ) : null}
    </li>
  );
}
