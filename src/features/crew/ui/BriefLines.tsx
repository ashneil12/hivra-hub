// Hivra WP-15: one compact line per brief. It opens the Crew tab filtered to that brief.

import { openCrew } from "../model/focus";

export function CrewBriefLines({ lines }: { lines?: readonly { id: string; text: string }[] }) {
  if (!lines?.length) return null;
  return (
    <div data-crew-briefs className="flex flex-col gap-1 pb-1.5">
      {lines.map((line) => (
        <button
          key={line.id}
          type="button"
          data-crew-brief={line.id}
          onClick={() => openCrew(line.id)}
          className="block w-full truncate px-1 text-left font-sans text-[12px] text-content/70 hover:text-content"
        >
          {line.text}
        </button>
      ))}
    </div>
  );
}
