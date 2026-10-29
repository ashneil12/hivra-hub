// This window publishes its Session.busy set; it reads the process union so
// the rail shows mid-turn chats another window started (liveTurns.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  listLiveTurns,
  mergeLiveTurns,
  publishLiveTurns,
  subscribeLiveTurns,
} from "../model/liveTurns";

function setKey(ids: ReadonlySet<string>): string {
  return [...ids].sort().join("\n");
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function useLiveTurns(localBusy: ReadonlySet<string>): Set<string> {
  const [remote, setRemote] = useState<readonly string[]>([]);
  const localKey = setKey(localBusy);
  const remoteKey = [...remote].sort().join("\n");

  useEffect(() => {
    let cancelled = false;
    void listLiveTurns()
      .then((ids) => {
        if (!cancelled && Array.isArray(ids)) setRemote(ids);
      })
      .catch(() => undefined);
    const unlisten = subscribeLiveTurns((ids) => {
      if (!cancelled) setRemote(ids);
    });
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void publishLiveTurns(localKey ? localKey.split("\n") : [])
      .then((ids) => {
        if (!cancelled && Array.isArray(ids)) setRemote(ids);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [localKey]);

  const merged = useMemo(() => {
    const local = new Set(localKey ? localKey.split("\n") : []);
    const live = new Set(remoteKey ? remoteKey.split("\n") : []);
    return mergeLiveTurns(local, live);
  }, [localKey, remoteKey]);
  const mergedRef = useRef(merged);
  if (!sameSet(mergedRef.current, merged)) mergedRef.current = merged;
  return mergedRef.current;
}
