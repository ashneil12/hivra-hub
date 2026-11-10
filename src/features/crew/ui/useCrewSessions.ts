// Hivra WP-119: the chats the crew tree draws. Text updates wake only those chats.

import { useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { sameProjectPath } from "../../projects/model/recents";
import type { Session } from "../../sessions/model/session";
import { SessionStateContext } from "../../sessions/model/sessionStateStore";
import type { CrewTreeSession } from "../model/crewTree";

const EMPTY: CrewTreeSession[] = [];

function clean(value: string): string {
  return value.replace(/\r/g, "").trim();
}

function wantedIds(sessions: readonly Session[], project: string, extra: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const id of extra) {
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  const folder = clean(project);
  if (folder && folder !== "~") {
    for (const session of sessions) {
      if (session.firstMate === true && session.cwd && sameProjectPath(clean(session.cwd), folder)) ids.add(session.id);
    }
  }
  return [...ids].sort();
}

function toTreeSession(session: Session): CrewTreeSession {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    firstMate: session.firstMate === true,
    busy: session.busy === true,
    blocks: Array.isArray(session.blocks) ? session.blocks : [],
  };
}

/** Live sessions for one project. The same array comes back until one of those chats changes. */
export function useCrewSessions(project: string, extraIds: readonly string[]): CrewTreeSession[] {
  const store = useContext(SessionStateContext);
  const extraKey = extraIds.join("\0");
  const extraRef = useRef(extraIds);
  extraRef.current = extraIds;
  const cache = useRef<{ key: string; refs: Session[]; view: CrewTreeSession[] } | null>(null);

  const subscribe = useCallback(
    (onStore: () => void) => {
      if (!store) return () => {};
      const watched = new Map<string, () => void>();
      const follow = () => {
        const want = new Set(wantedIds(store.snapshot(), project, extraRef.current));
        for (const [id, off] of watched) {
          if (!want.has(id)) {
            off();
            watched.delete(id);
          }
        }
        for (const id of want) {
          if (!watched.has(id)) watched.set(id, store.subscribe(id, onStore));
        }
      };
      follow();
      const offShell = store.subscribeShell(() => {
        follow();
        onStore();
      });
      return () => {
        offShell();
        for (const off of watched.values()) off();
        watched.clear();
      };
    },
    [store, project, extraKey],
  );

  const getSnapshot = useCallback(() => {
    if (!store) return EMPTY;
    const ids = wantedIds(store.snapshot(), project, extraRef.current);
    const refs: Session[] = [];
    for (const id of ids) {
      const session = store.session(id);
      if (session) refs.push(session);
    }
    const key = `${project}\0${extraKey}`;
    const prev = cache.current;
    if (prev && prev.key === key && prev.refs.length === refs.length && prev.refs.every((session, index) => session === refs[index])) {
      return prev.view;
    }
    const view = refs.map(toTreeSession);
    cache.current = { key, refs, view };
    return view;
  }, [store, project, extraKey]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
