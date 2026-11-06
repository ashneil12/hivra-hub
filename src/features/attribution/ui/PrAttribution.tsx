import type { PrCredit } from "../read";

/** Agents and tasks behind a pull request. Nothing, when neither is known. */
export function PrAttribution({ credit }: { credit: PrCredit }) {
  if (credit.agents.length === 0 && credit.tasks.length === 0) return null;
  return (
    <section aria-label="Who made this" className="mt-3 text-[12px] text-content">
      {credit.agents.length > 0 ? (
        <p>
          <span className="text-content/70">Agents </span>
          {credit.agents.join(", ")}
        </p>
      ) : null}
      {credit.tasks.length > 0 ? (
        <p>
          <span className="text-content/70">Tasks </span>
          {credit.tasks.map((task) => task.title).join(", ")}
        </p>
      ) : null}
    </section>
  );
}
