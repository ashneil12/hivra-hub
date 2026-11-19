// Hivra WP-119: the chats the crew tree draws. Text updates wake only those chats, and they redraw nothing: the view
// holds only what the tree reads, so the words of a reply arriving leave the same array in place.

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

/**
 * The blocks crewTree reads: the prompts (a node's brief), and the tool calls and subagent runs (its latest tool and
 * its children). The words of a reply (assistant and reasoning text) are not read, and they are the only blocks a
 * text-only stream update changes.
 */
const DRAWN_ROLES: ReadonlySet<string> = new Set(["user", "tool", "approval"]);

function toTreeSession(session: Session): CrewTreeSession {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    firstMate: session.firstMate === true,
    busy: session.busy === true,
    blocks: Array.isArray(session.blocks) ? session.blocks.filter((block) => DRAWN_ROLES.has(block?.role)) : [],
  };
}

function sameDrawn(a: CrewTreeSession, b: CrewTreeSession): boolean {
  if (a.id !== b.id || a.title !== b.title || a.cwd !== b.cwd) return false;
  if (a.firstMate !== b.firstMate || a.busy !== b.busy) return false;
  const left = a.blocks ?? [];
  const right = b.blocks ?? [];
  return left.length === right.length && left.every((block, index) => block === right[index]);
}

/**
 * Live sessions for one project. The same array comes back until something the tree draws changes in one of those
 * chats. A text-only stream update wakes this hook but not the panel, since React keeps the panel as it is when the
 * snapshot is the same array.
 */
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
    // A chat changed, but not in anything the tree reads (the words of a reply): keep the view the panel already has.
    if (prev && prev.key === key && prev.view.length === view.length && prev.view.every((entry, index) => sameDrawn(entry, view[index]))) {
      cache.current = { key, refs, view: prev.view };
      return prev.view;
    }
    cache.current = { key, refs, view };
    return view;
  }, [store, project, extraKey]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
