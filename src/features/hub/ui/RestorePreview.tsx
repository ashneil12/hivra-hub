import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft } from "../../../shared/ui/icons";
import { setHubSelection } from "../model/hubNav";
import { restore, setPendingImport, usePendingImport } from "../../portable/model/portable";
import type { ImportSummary, PendingImport } from "../../portable/model/importPlan";
import { ImportPreview } from "../../portable/ui/ImportPreview";

/**
 * The hub's Restore page (from onboarding or the empty Today): what an export brings, before anything is added. It
 * reads the export picked there; a caller can pass one in.
 */
export function RestorePreview({ pending: given, onBack, onRestore, inline }: {
  pending?: PendingImport;
  onBack?: () => void;
  onRestore?: (p: PendingImport, ...rest: Parameters<Parameters<typeof ImportPreview>[0]["onRestore"]>) => Promise<ImportSummary>;
  inline?: boolean;
}) {
  const picked = usePendingImport();
  const p = given ?? picked;
  const back = onBack ?? (() => { setPendingImport(null); setHubSelection({ project: "today", item: "inbox" }); });
  const body = !p ? (
    <div className="grid h-full place-items-center text-[13px] text-content/60">No export picked.</div>
  ) : (
    <ImportPreview inline={inline} pending={p} onBack={back} onRestore={(plan, choices) => (onRestore ?? restore)(p, plan, choices)} />
  );
  if (inline) return body;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-restore>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        <button type="button" aria-label="Back" title="Back" onClick={back}
          className="grid size-6 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content">
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </button>
        <span className="text-[13px] text-content">Restore from an export</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}
