// The programme on Home. Empty renders nothing, so a quiet home stays quiet.

import type { ProgrammeGroup, ProgrammePackage } from "../model/programme";
import { clipText, programmeGroup } from "../model/programme";

/** Display only: a long title or reason is clipped here, the row keeps all of it. */
const SHOW_MAX = 200;

const GROUPS: { id: ProgrammeGroup; title: string }[] = [
  { id: "queued", title: "Queued" },
  { id: "flight", title: "In flight" },
  { id: "parked", title: "Parked" },
  { id: "failed", title: "Failed" },
];

function line(row: ProgrammePackage): string {
  const extra = [row.securityPark ? "Security check." : "", row.parkReason ?? ""].filter((part) => part !== "").join(" ");
  const title = clipText(row.title, SHOW_MAX);
  return extra ? `${title}. ${clipText(extra, SHOW_MAX)}` : `${title}.`;
}

export function ProgrammePanel({
  rows,
  onClear,
  notice,
}: {
  rows: readonly ProgrammePackage[];
  onClear?: (row: ProgrammePackage) => void;
  notice?: string;
}) {
  const grouped = GROUPS.map((group) => ({
    ...group,
    rows: rows.filter((row) => programmeGroup(row) === group.id),
  })).filter((group) => group.rows.length > 0);
  if (grouped.length === 0 && !notice) return null;
  return (
    <section data-programme aria-label="Programme" className="rounded-lg border border-stroke">
      <h2 className="px-3 py-2 text-[13px] font-medium text-content">Programme</h2>
      {grouped.map((group) => (
        <div key={group.id} data-programme-group={group.id}>
          <h3 className="border-t border-stroke px-3 py-2 text-[13px] text-content">{group.title}</h3>
          {group.rows.map((row) => (
            <div key={row.id} className="flex min-h-10 items-center gap-3 border-t border-stroke px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[13px] text-content">{line(row)}</span>
              {group.id === "parked" && onClear ? (
                <button
                  type="button"
                  className="text-[12px] text-content/70 underline-offset-2 hover:underline"
                  aria-label={`Clear park for ${row.title}`}
                  onClick={() => onClear(row)}
                >
                  Clear park
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {notice ? <p data-programme-notice className="border-t border-stroke px-3 py-2 text-[13px] text-content">{notice}</p> : null}
    </section>
  );
}
