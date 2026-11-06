import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readPrCredit, type PrCredit } from "../read";

const SHA = /^[0-9a-f]{7,64}$/;
const EMPTY: PrCredit = { agents: [], tasks: [] };

/** Commit ids from a pull request thread. Anything else is ignored. At most 200. */
export function commitOids(thread: unknown): string[] {
  if (!thread || typeof thread !== "object") return [];
  const commits = (thread as { commits?: unknown }).commits;
  if (!Array.isArray(commits)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of commits) {
    if (!item || typeof item !== "object") continue;
    const oid = (item as { oid?: unknown }).oid;
    if (typeof oid !== "string" || !SHA.test(oid) || seen.has(oid)) continue;
    seen.add(oid);
    out.push(oid);
    if (out.length === 200) break;
  }
  return out;
}

/**
 * Who is behind these commits. A new pull request clears first. A failed read
 * keeps what is already on screen for the same commits.
 */
export function usePrAttribution(repo: string, thread: unknown): PrCredit {
  const oids = commitOids(thread);
  const key = `${repo}\n${oids.join(",")}`;
  const oidsRef = useRef(oids);
  oidsRef.current = oids;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [credit, setCredit] = useState<PrCredit>(EMPTY);
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setCredit(EMPTY);
  }
  useEffect(() => {
    if (!repo || oidsRef.current.length === 0) return;
    let cancelled = false;
    const asked = key;
    try {
      void Promise.resolve(invoke("attribution_for_commits", { repo, shas: oidsRef.current }))
        .then((value) => {
          if (!cancelled && keyRef.current === asked) setCredit(readPrCredit(value));
        })
        .catch(() => {
          // The rows already on screen stay.
        });
    } catch {
      // The app isn't there. Leave the list as it is.
    }
    return () => {
      cancelled = true;
    };
  }, [key, repo]);
  return shownKey === key ? credit : EMPTY;
}
