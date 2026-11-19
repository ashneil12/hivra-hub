// WP-165: the morning list of overnight drafts. Reading a brief does not start work.

import type { MorningDraft } from "../model/morning";

/** Drafts waiting in the morning. There is no control here that starts, merges or spends. */
export function MorningDrafts({ drafts }: { drafts: readonly MorningDraft[] }) {
  if (!drafts.length) return null;
  return (
    <section data-overnight-drafts="" aria-label="Overnight drafts" className="rounded-lg border border-stroke px-3 py-2">
      <h2 className="text-[13px] font-medium text-content">Overnight drafts</h2>
      <ul className="mt-2 flex flex-col gap-2">
        {drafts.map((draft) => (
          <li key={draft.id} data-overnight-draft={draft.parked ? "parked" : "waiting"} className="text-[13px] text-content">
            <p>{draft.title}</p>
            <p className="text-content/70">{draft.parked ? "Parked for a security check." : "Waiting for you."}</p>
            {draft.brief ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-content/70">Read the brief</summary>
                <p className="mt-1 whitespace-pre-wrap">{draft.brief}</p>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
