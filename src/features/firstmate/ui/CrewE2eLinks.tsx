// WP-42. `.e2e` proof on a worker's report, until the Crew tab lists it. Paths only: nothing is opened from here.

import { e2eEvidence } from "../model/e2eEvidence";
import { storedReport } from "../model/report";

export function CrewE2eLinks({ report }: { report?: string | null }) {
  const paths = e2eEvidence(storedReport(report)?.evidence ?? []);
  if (paths.length === 0) return null;
  return (
    <ul data-e2e-evidence aria-label="Verify evidence" className="m-0 flex list-none flex-wrap gap-1 p-0">
      {paths.map((path) => (
        <li key={path}>
          <span data-e2e-path={path} className="font-mono text-[11px] text-content/60">
            {path}
          </span>
        </li>
      ))}
    </ul>
  );
}
