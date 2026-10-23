import { useState } from "react";
import { revealPath } from "../../../platform/tauri/fs";
import { useHarnessIssues } from "../model/harnessIssues";

/**
 * Harness care on Today (monos/model/harnessCare.ts; board H1/H3): what the app can see about itself and can't fix by
 * itself — its database failing the build's own check, a shipped build's trial that never committed, a pull request
 * watch it had to pause. One plain line each, no badge. A fix the app could make leaves no card: it is a Bot changes
 * row. It shows even when the hub can't load, because these are the app's own surroundings (as ShipNotice does).
 */
export function HarnessCareNotice({ inBody = false }: { inBody?: boolean } = {}) {
  const rows = useHarnessIssues();
  const [problem, setProblem] = useState<string | null>(null);
  if (!rows.length) return null;
  return (
    <div className={inBody ? "" : "mx-auto max-w-[720px] px-8 pt-8"} data-hub-harness-care>
      <section aria-label="Harness" className="rounded-lg border border-stroke px-3 py-2.5 hub-fade-in">
        <p className="text-[13px] leading-5 text-content">The app found something in itself it can't fix by itself:</p>
        <ul className="mt-1 space-y-0.5">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 text-[13px] leading-5 text-content/80" data-hub-harness-issue={row.id}>
              <span>{row.line}</span>
              {row.path ? (
                <button
                  type="button"
                  onClick={() =>
                    void revealPath(row.path!).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
                  }
                  className="rounded-md px-2 py-0.5 text-[12px] text-content/60 hover:bg-content/5 hover:text-content"
                >
                  Show the log
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {problem ? (
          <p role="alert" className="mt-1.5 text-[12px] leading-5 text-content/70">
            Couldn't show the log: {problem}
          </p>
        ) : null}
      </section>
    </div>
  );
}
