// WP-74: one search across the index and the search the app already has.
// A failed or timed-out load keeps the hits stored for this same query. Another
// query's hits are not shown, including before its load returns. A late load is dropped.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { hubData } from "../../hub/model/hubData";
import { listMonos, type Mono } from "../../monos/model/mono";
import { taskProjectKeys } from "../../tasks/model/projects";
import type { RecentProject } from "../../projects/model/recents";
import {
  loadProjectFiles,
  rankProjectFiles,
  recentOpenedFiles,
} from "../../files/model/fileIndex";
import type { Block, HarnessId } from "../../sessions/model/session";
import {
  cancelSessionSearch,
  searchSessions,
} from "../../sessions/data/sessionStore";
import {
  hitsFromContentMatches,
  hitsFromFileRanks,
  hitsFromSessionSearch,
  searchConversationTitles,
  searchRecentProjects,
  searchSessionMessages,
  type AppSearchHit,
} from "./appSearch";
import {
  acceptGeneration,
  assembleFinder,
  hitsFromIndex,
  parseFinderQuery,
  rowsForQuery,
  storeHeld,
  toggleFinderScope,
  type FinderHit,
  type FinderScope,
  type HeldRows,
} from "./finder";
import { cancelProjectSearch, searchProject } from "./search";

export type FinderHistoryRow = {
  id: string;
  cwd: string;
  harness: HarnessId;
  title: string;
  updatedAt: number;
};

export type FinderSessionRow = {
  id: string;
  cwd: string;
  harness: HarnessId;
  title: string;
  blocks: Block[];
};

export type FinderSearchIO = {
  indexed: (text: string) => Promise<FinderHit[]>;
  remote: (text: string, owner: string) => Promise<AppSearchHit[]>;
  content: (cwd: string, text: string, searchId: string) => Promise<AppSearchHit[]>;
  files: (cwd: string, text: string) => Promise<AppSearchHit[]>;
  cancelRemote: (owner: string) => Promise<void>;
  cancelContent: (cwd: string, searchId: string) => Promise<void>;
  monos: () => readonly Mono[];
  keys: (cwd: string) => readonly string[];
};

async function attempt<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch {
    return { ok: false };
  }
}

function projectKeys(cwd: string): string[] {
  try {
    const projects = hubData().listProjects();
    return taskProjectKeys(cwd, projects).read;
  } catch {
    return cwd ? [cwd] : [];
  }
}

function readMonos(): readonly Mono[] {
  try {
    return listMonos();
  } catch {
    return [];
  }
}

export const finderSearchIO: FinderSearchIO = {
  indexed: async (text) => hitsFromIndex(await invoke("finder_search", { query: text })),
  remote: async (text, owner) => {
    const result = await searchSessions({ query: text, searchOwner: owner });
    return hitsFromSessionSearch(result.hits);
  },
  content: async (cwd, text, searchId) => {
    const result = await searchProject({ cwd, query: text, searchId });
    return hitsFromContentMatches(result.matches);
  },
  files: async (cwd, text) => {
    const files = await loadProjectFiles(cwd);
    return hitsFromFileRanks(rankProjectFiles(files, text, recentOpenedFiles(cwd), 40));
  },
  cancelRemote: (owner) => cancelSessionSearch(owner),
  cancelContent: (cwd, searchId) => cancelProjectSearch(cwd, searchId),
  monos: readMonos,
  keys: projectKeys,
};

export function useFinderSearch(
  input: {
    open: boolean;
    query: string;
    cwd: string;
    history: readonly FinderHistoryRow[];
    sessions: readonly FinderSessionRow[];
    recents: readonly RecentProject[];
  },
  io: FinderSearchIO = finderSearchIO,
): { hits: FinderHit[]; scope: FinderScope; toggleScope: () => void } {
  const [hits, setHits] = useState<FinderHit[]>([]);
  const [scope, setScope] = useState<FinderScope>("project");
  const generation = useRef(0);
  const indexedRef = useRef<HeldRows<FinderHit>>({ query: "", rows: [] });
  const remoteRef = useRef<HeldRows<AppSearchHit>>({ query: "", rows: [] });
  const contentRef = useRef<HeldRows<AppSearchHit>>({ query: "", rows: [] });
  const fileRef = useRef<HeldRows<AppSearchHit>>({ query: "", rows: [] });
  const historyRef = useRef(input.history);
  const sessionsRef = useRef(input.sessions);
  const recentsRef = useRef(input.recents);
  historyRef.current = input.history;
  sessionsRef.current = input.sessions;
  recentsRef.current = input.recents;

  useEffect(() => {
    if (input.open) setScope("project");
  }, [input.open]);

  useEffect(() => {
    if (!input.open) return;
    const parsed = parseFinderQuery(input.query);
    if (parsed.mode === "commands" || !parsed.text) {
      setHits([]);
      return;
    }
    const mine = ++generation.current;
    const text = parsed.text;
    const cwd = input.cwd;
    const owner = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `finder-${mine}`;
    const searchId = `${owner}-files`;
    let cancelled = false;

    const publish = () => {
      if (cancelled || !acceptGeneration(generation.current, mine)) return;
      const keys = io.keys(cwd);
      setHits(
        assembleFinder({
          query: input.query,
          scope,
          project: cwd,
          keys,
          indexed: rowsForQuery(indexedRef.current, text),
          app: [
            ...searchConversationTitles(
              historyRef.current.map((row) => ({
                id: row.id,
                cwd: row.cwd,
                harness: row.harness,
                title: row.title,
                updatedAt: row.updatedAt,
              })),
              text,
            ),
            ...searchSessionMessages(
              sessionsRef.current.map((session) => ({
                id: session.id,
                cwd: session.cwd,
                harness: session.harness,
                title: session.title,
                updatedAt: 0,
                blocks: session.blocks,
              })),
              text,
            ),
            ...searchRecentProjects([...recentsRef.current], text),
            ...rowsForQuery(remoteRef.current, text),
            ...rowsForQuery(contentRef.current, text),
            ...rowsForQuery(fileRef.current, text),
          ],
          monos: io.monos(),
        }),
      );
    };

    publish();
    let stopped = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const [indexed, remote, files, body] = await Promise.all([
          attempt(() => io.indexed(text)),
          attempt(() => io.remote(text, owner)),
          attempt(() => io.files(cwd, text)),
          attempt(() => io.content(cwd, text, searchId)),
        ]);
        if (cancelled || stopped || !acceptGeneration(generation.current, mine)) return;
        indexedRef.current = storeHeld(indexedRef.current, text, indexed);
        remoteRef.current = storeHeld(remoteRef.current, text, remote);
        fileRef.current = storeHeld(fileRef.current, text, files);
        contentRef.current = storeHeld(contentRef.current, text, body);
        publish();
      })();
    }, 40);

    return () => {
      cancelled = true;
      stopped = true;
      window.clearTimeout(timer);
      void io.cancelRemote(owner).catch(() => undefined);
      void io.cancelContent(cwd, searchId).catch(() => undefined);
    };
  }, [input.open, input.query, input.cwd, io, scope]);

  return {
    hits,
    scope,
    toggleScope: () => setScope((current) => toggleFinderScope(current)),
  };
}
