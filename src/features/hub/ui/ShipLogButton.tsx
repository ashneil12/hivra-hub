// The update log's home: Settings, General, beside the version. The bar on the main pane is only for what Ash must
// act on (ShipNotice), so this is the path to the last ship's log when he wants it.
import { useState } from "react";
import { useShipStatus } from "../../../app/model/ship";
import { revealPath } from "../../../platform/tauri/fs";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";

export function ShipLogButton() {
  const log = useShipStatus().current?.log;
  const [problem, setProblem] = useState<string | null>(null);
  if (!log) return null;
  return (
    <div className="flex items-center gap-2">
      <SecondaryButton
        data-ship-log=""
        onClick={() => {
          setProblem(null);
          void revealPath(log).catch((error: unknown) =>
            setProblem(`Couldn't show the update log: ${error instanceof Error ? error.message : String(error)}`),
          );
        }}
      >
        Show the update log
      </SecondaryButton>
      {problem ? (
        <span role="alert" className="text-[12px] text-content/60">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
