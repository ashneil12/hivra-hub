// WP-74: the existing file palette, with the finder filling it when ⌘K opened it.

import { useState } from "react";
import { FilePicker } from "../../files/ui/FilePicker";
import type { RecentProject } from "../../projects/model/recents";
import type { OpenFileFn } from "../model/search";
import type { FinderHit } from "../model/finder";
import { useFinderSearch, type FinderHistoryRow, type FinderSessionRow } from "../model/finderSearch";

type Props = {
  /** When set, the palette searches every kind. File search stays as it was. */
  finder: boolean;
  open: boolean;
  cwd: string;
  openPaths?: string[];
  initialQuery?: string;
  history: readonly FinderHistoryRow[];
  sessions: readonly FinderSessionRow[];
  recents: readonly RecentProject[];
  onOpenFile: OpenFileFn;
  onRunAction: (id: string) => void;
  onClose: () => void;
  onOpenHit: (hit: FinderHit, beside: boolean, query: string) => void;
};

export function FinderHost({
  finder,
  open,
  cwd,
  openPaths,
  initialQuery = "",
  history,
  sessions,
  recents,
  onOpenFile,
  onRunAction,
  onClose,
  onOpenHit,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const search = useFinderSearch({
    open: finder && open,
    query,
    cwd,
    history,
    sessions,
    recents,
  });

  return (
    <FilePicker
      open={open}
      cwd={cwd}
      openPaths={openPaths}
      initialQuery={initialQuery}
      onOpenFile={onOpenFile}
      onRunAction={onRunAction}
      onClose={onClose}
      finder={
        finder
          ? {
              hits: search.hits,
              scope: search.scope,
              onQuery: setQuery,
              onToggleScope: search.toggleScope,
              onOpen: (hit, beside) => onOpenHit(hit, beside, query),
            }
          : undefined
      }
    />
  );
}
