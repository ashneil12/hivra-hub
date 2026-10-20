// Where a connected page's live data comes from, and how it hears about changes: the same stores the app's own screens
// read (pageData.ts turns them into plain data). A page's watch subscribes here; nothing polls Ash OS for it: the hub
// store's change feed, the delegation feed, Waiting on you, the Monos roster and the chats already move on their own.
// One clock per sessions store notes when each chat last changed, so a chat that went quiet mid-turn can read as stuck.
import { hubData, liveHubStore } from "../../hub/model/hubData";
import { listChats } from "../../hub/model/hubChats";
import { subscribeWaitingChats, waitingChats } from "../../hub/model/waitingChats";
import { delegationRows, subscribeDelegations } from "../../monos/model/delegationStore";
import { findMono, listMonos, subscribeMonos } from "../../monos/model/mono";
import type { Session } from "../../sessions/model/session";
import type { SessionStateStore } from "../../sessions/model/sessionStateStore";
import type { PageSources } from "./pageBridgeHost";
import { agentName, agentsData, jobsData, needsData, roomsData } from "./pageData";

/** hubChats.ts's change event (its constant isn't exported): the rooms moved. */
const CHATS_CHANGED = "monocode:hub-chats-changed";
/** How often the agents are read again with nothing else moving, so "no progress for N min" turns up by itself. */
export const AGENTS_TICK_MS = 30_000;

type Sessions = Pick<SessionStateStore, "snapshot" | "session" | "subscribeShell">;

/** When each chat last changed (its object), first seen at the moment the clock first read it. */
export class ChatClock {
  private seen = new Map<string, { s: Session; at: number }>();
  read(sessions: readonly Session[], now: number): void {
    const next = new Map<string, { s: Session; at: number }>();
    for (const s of sessions) {
      const known = this.seen.get(s.id);
      next.set(s.id, known && known.s === s ? known : { s, at: now });
    }
    this.seen = next;
  }
  quietFor(sessionId: string, now: number): number | undefined {
    const known = this.seen.get(sessionId);
    return known ? Math.max(0, now - known.at) : undefined;
  }
}
const clocks = new WeakMap<object, ChatClock>();
const NO_SESSIONS = {};

function all(...subs: (() => void)[]): () => void {
  return () => subs.forEach((off) => off());
}
function onWindow(event: string, fn: () => void): () => void {
  window.addEventListener(event, fn);
  return () => window.removeEventListener(event, fn);
}
function onHub(fn: () => void): () => void {
  const store = liveHubStore();
  return store ? store.subscribe(fn) : () => undefined;
}

/** The app's live sources for a page; `sessions` is the app's chats (absent in a test or a page outside the app). */
export function appPageSources(sessions: Sessions | null, now: () => number = Date.now): PageSources {
  const clock = clocks.get(sessions ?? NO_SESSIONS) ?? new ChatClock();
  clocks.set(sessions ?? NO_SESSIONS, clock);
  const projects = () => hubData().listProjects();
  const jobs = () => liveHubStore()?.getSnapshot().jobs ?? [];
  return {
    "agents.read": {
      read: () => {
        const at = now();
        clock.read(sessions?.snapshot() ?? [], at);
        return agentsData({
          monos: listMonos(), session: (id) => sessions?.session(id), rows: delegationRows(), waiting: waitingChats(), jobs: jobs(),
          projects: projects(), quietFor: (id) => clock.quietFor(id, at), now: at,
        });
      },
      subscribe: (fn) => {
        const tick = setInterval(fn, AGENTS_TICK_MS);
        return all(subscribeMonos(fn), subscribeDelegations(fn), subscribeWaitingChats(fn), sessions?.subscribeShell(fn) ?? (() => undefined), onHub(fn), () => clearInterval(tick));
      },
    },
    "jobs.read": { read: () => jobsData(jobs(), projects()), subscribe: onHub },
    "needs.read": {
      read: () => needsData(hubData().listNeeds(), waitingChats(), projects()),
      subscribe: (fn) => all(onHub(fn), subscribeWaitingChats(fn)),
    },
    "rooms.read": {
      read: (args) => roomsData(projects().flatMap((p) => listChats(p.id)), (id) => { const m = findMono(id); return m ? agentName(m) : id; }, args),
      subscribe: (fn) => all(onWindow(CHATS_CHANGED, fn), subscribeMonos(fn)),
    },
  };
}
