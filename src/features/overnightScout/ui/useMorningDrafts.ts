// WP-165: Home reads the scout record. A late reply is dropped. A timeout keeps the list already shown.

import { useEffect, useState } from "react";
import type { LocalHubDisk } from "../../hub/model/localHub/localHub";
import { morningDrafts, type MorningDraft } from "../model/morning";
import { readScoutDoc, SCOUT_DOC_KEY } from "../model/store";

const RETRY_MS = 2000;

/** The morning list, or null when the store did not answer. */
export async function readMorningDrafts(disk: LocalHubDisk): Promise<MorningDraft[] | null> {
  try {
    const { doc } = await readScoutDoc(disk);
    return morningDrafts(doc.rows, doc.briefs);
  } catch {
    return null;
  }
}

/** Drafts for the morning list. A failed read keeps the previous list and tries again. */
export function useMorningDrafts(disk: LocalHubDisk): MorningDraft[] {
  const [drafts, setDrafts] = useState<MorningDraft[]>([]);
  useEffect(() => {
    let stopped = false;
    let token = 0;
    let timer = 0;
    const load = () => {
      window.clearTimeout(timer);
      const mine = ++token;
      void readMorningDrafts(disk).then((next) => {
        if (stopped || mine !== token) return;
        if (!next) {
          timer = window.setTimeout(load, RETRY_MS);
          return;
        }
        setDrafts(next);
      });
    };
    load();
    const stopWatch = disk.watch?.((key) => {
      if (key === SCOUT_DOC_KEY) load();
    });
    return () => {
      stopped = true;
      token += 1;
      window.clearTimeout(timer);
      stopWatch?.();
    };
  }, [disk]);
  return drafts;
}
