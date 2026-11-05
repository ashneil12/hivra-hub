// WP-74: the finder's results, in the order they were ranked.

import { useEffect, useRef } from "react";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { groupFinderHits, type FinderHit } from "../model/finder";

export function FinderList({
  hits,
  active,
  onActive,
  onOpen,
}: {
  hits: readonly FinderHit[];
  active: number;
  onActive: (index: number) => void;
  onOpen: (hit: FinderHit, beside: boolean) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeRef = useRef<HTMLButtonElement>(null);
  const groups = groupFinderHits(hits);
  let index = 0;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={lockOverscroll}
      role="listbox"
      aria-label="Finder results"
      data-finder-results
      className="max-h-[min(380px,50vh)] overflow-y-auto overscroll-none px-1.5 pb-1.5"
    >
      {groups.map((group) => (
        <div key={`${group.kind}:${group.hits[0]?.id ?? ""}`}>
          <p className="px-2 pb-0.5 pt-1.5 text-[11px] text-content/50">{group.label}</p>
          {group.hits.map((hit) => {
            const position = index;
            index += 1;
            const highlighted = position === active;
            return (
              <button
                key={hit.id}
                ref={highlighted ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={highlighted}
                data-finder-kind={hit.kind}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onActive(position)}
                onClick={() => onOpen(hit, false)}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm leading-none ${
                  highlighted ? "bg-selection text-content" : "text-content"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{hit.title}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
