import { useId, useState } from "react";
import { lineageTally, type Lineage, type LineageChild, type LineageStatus } from "../model/subagentLineage";

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
 *
 * It lives in the transcript's own scroll content, so it can never take height from the newest messages, and it
 * opens as one line: the tally of what the children are doing. The rows open on request, in a box that stops at
 * a share of the pane and scrolls inside, so a dozen children cost one line until the reader asks. The transcript
 * keeps the per-turn row for each run (its steps open there); this is the thread-wide view of how each one ended.
 */
export function LineageList({ lineage }: { lineage: Lineage }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (lineage.reported && lineage.children.length === 0) return null;
  if (!lineage.reported) {
    return (
      <section data-lineage className="flex items-baseline gap-2 px-4 py-2 font-sans text-sm text-content/50">
        <h2 className="text-[12px] text-content/40">Subagents</h2>
        <p data-lineage-unreported>{sentence(lineage.label)}</p>
      </section>
    );
  }
  return (
    <section data-lineage className="min-w-0 px-4 py-1 font-sans">
      <button
        type="button"
        data-lineage-toggle
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-baseline gap-2 py-1 text-left text-[12px] text-content/40 hover:text-content/60"
      >
        <h2 className="shrink-0">Subagents</h2>
        <span data-lineage-summary className="min-w-0 flex-1 truncate">
          {lineageTally(lineage.children)}
        </span>
        <span aria-hidden className="shrink-0">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open ? (
        <ul
          id={listId}
          data-lineage-rows
          className="flex max-h-56 min-w-0 flex-col overflow-y-auto overscroll-contain"
        >
          {lineage.children.map((child) => (
            <LineageRow key={child.id} child={child} />
          ))}
        </ul>
      ) : null}
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
