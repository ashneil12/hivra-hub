// G7: the teams Ash set up and the Mono proposals (Settings > Teams, hubTeams.ts) in one hub document, `hub-teams`, in
// the app's database (src-tauri/src/local_hub.rs). Every window reads the same one and it survives a restart. A write
// lands only on the revision just read; when another window wrote first, the change is read again and made on top.
// Every window hears each write (`local-hub://changed`) and reads it again.
//
// hubTeams.ts answers its callers at once (createTeam returns the team), so a change shows straight away: what the
// window shows is the document as last read with this window's changes still on their way laid over it. A change that
// can't be saved comes off the screen again and is said. Each change is written so that making it twice is harmless.
//
// They used to live in this window's storage (`monocode:hub-teams`). The first start of this build copies them across
// once (only adds, by id; a proposal still waiting there is closed, as the old load did); the old key stays as it was,
// so a rolled-back build still finds them.
import { memoryDisk, type LocalHubDisk } from "./localHub/localHub";
import { tauriLocalHubDisk } from "./localHub/localTransport";
import type { MonoProposal, Team } from "./hubTeams";

export const TEAMS_DOC_KEY = "hub-teams";
export const LEGACY_TEAMS_KEY = "monocode:hub-teams";
/** Set once the old key's teams are in the database, so they are never copied twice. */
export const TEAMS_IMPORTED_KEY = "monocode:hub-teams.imported";
const TRIES = 5;

export type TeamsDoc = { teams: Team[]; proposals: MonoProposal[] };
type Change = (doc: TeamsDoc) => TeamsDoc;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export const emptyTeams = (): TeamsDoc => ({ teams: [], proposals: [] });

const withId = <T>(list: unknown): T[] =>
  Array.isArray(list) ? (list.filter((x) => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") as T[]) : [];

/** The document as kept (anything that isn't a team or proposal with an id is left out). */
export function parseTeams(raw: unknown): TeamsDoc {
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    teams: withId<Team>(rec.teams).filter((t) => typeof t.name === "string" && Array.isArray(t.projects) && Array.isArray(t.memberIds)),
    proposals: withId<MonoProposal>(rec.proposals).filter((p) => !!p.spec && typeof p.status === "string"),
  };
}

/** What the old key held: a proposal still waiting there is closed (a Mono is made in chat with Ash now). */
function legacyTeams(raw: string | null): TeamsDoc | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const doc = parseTeams(value);
  if (!doc.teams.length && !doc.proposals.length) return undefined;
  return { teams: doc.teams, proposals: doc.proposals.map((p) => (p.status === "pending" ? { ...p, status: "declined" as const } : p)) };
}

/** Only adds: a team or proposal the document already has keeps its own record. */
const addMissing = (from: TeamsDoc): Change => (doc) => ({
  teams: [...doc.teams, ...from.teams.filter((t) => !doc.teams.some((x) => x.id === t.id))],
  proposals: [...doc.proposals, ...from.proposals.filter((p) => !doc.proposals.some((x) => x.id === p.id))],
});

export type TeamsStore = {
  /** Read the document once (and copy the old key across, once). A failed read is tried again next time. */
  load(): Promise<void>;
  /** What the window shows: the document with this window's unsaved changes on top. */
  view(): TeamsDoc;
  /** Shown at once; resolves when saved, rejects (and takes it back off the screen) when it can't be. */
  change(fn: Change): Promise<void>;
  /** Every change asked so far has been saved or given up. */
  settled(): Promise<void>;
  /** The last change that couldn't be saved, in plain words, until one is. */
  problem(): string | undefined;
  subscribe(fn: () => void): () => void;
};

export function createTeamsStore(disk: LocalHubDisk, storage: Storage | undefined): TeamsStore {
  let base = emptyTeams();
  let rev = 0;
  let pending: Change[] = [];
  let view = base;
  let problem: string | undefined;
  let loading: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const show = () => {
    view = pending.reduce((doc, fn) => {
      try {
        return fn(doc);
      } catch {
        return doc;
      }
    }, base);
    for (const fn of [...listeners]) fn();
  };
  const adopt = (doc: TeamsDoc, at: number) => {
    if (at < rev) return;
    base = doc;
    rev = at;
    show();
  };
  const read = async () => {
    const doc = await disk.readDoc(TEAMS_DOC_KEY);
    return { doc: parseTeams(doc.value), rev: doc.rev };
  };
  /** One after another in this window. */
  const queue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  };
  /** Read, change, write on that revision; a refused write (another window) reads again and goes on top. */
  const writeNow = async (fn: Change): Promise<boolean> => {
    for (let attempt = 0; attempt < TRIES; attempt += 1) {
      let latest: { doc: TeamsDoc; rev: number };
      try {
        latest = await read();
      } catch {
        continue;
      }
      const next = fn(latest.doc);
      if (JSON.stringify(next) === JSON.stringify(latest.doc)) {
        pending = pending.filter((f) => f !== fn);
        adopt(latest.doc, latest.rev);
        return true;
      }
      let at: number | null;
      try {
        at = await disk.write(TEAMS_DOC_KEY, next, latest.rev);
      } catch {
        continue;
      }
      if (at == null) continue;
      pending = pending.filter((f) => f !== fn);
      adopt(next, at);
      return true;
    }
    return false;
  };

  const refresh = async () => {
    const latest = await read();
    adopt(latest.doc, latest.rev);
  };
  disk.watch?.((key, at) => {
    if (key === TEAMS_DOC_KEY && at > rev) void refresh().catch(() => undefined);
  });

  const importOnce = async () => {
    let raw: string | null = null;
    try {
      if (storage?.getItem(TEAMS_IMPORTED_KEY)) return;
      raw = storage?.getItem(LEGACY_TEAMS_KEY) ?? null;
    } catch {
      return; // no storage to read: nothing to bring across
    }
    const old = legacyTeams(raw);
    if (old && !(await writeNow(addMissing(old)))) return; // tried again next start
    try {
      storage?.setItem(TEAMS_IMPORTED_KEY, new Date().toISOString());
    } catch {
      /* without the mark the next start adds nothing new: the import only adds */
    }
  };

  return {
    load() {
      if (!loading) {
        const reading = queue(async () => {
          await refresh();
          await importOnce();
        });
        loading = reading;
        reading.catch(() => {
          if (loading === reading) loading = undefined;
        });
      }
      return loading;
    },
    view: () => view,
    change(fn) {
      pending.push(fn);
      show();
      return queue(async () => {
        if (await writeNow(fn)) {
          if (problem) {
            problem = undefined;
            show();
          }
          return;
        }
        pending = pending.filter((f) => f !== fn);
        problem = "The team change couldn't be saved. Try again.";
        console.error(problem);
        show();
        throw new Error(problem);
      });
    },
    settled: () => chain.then(() => undefined),
    problem: () => problem,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** The window's store: the app's database in the app (and the browser preview's stand-in for it), memory elsewhere. */
export function appTeamsStore(): TeamsStore {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  let storage: Storage | undefined;
  try {
    storage = localStorage;
  } catch {
    storage = undefined;
  }
  return createTeamsStore(inTauri ? tauriLocalHubDisk : memoryDisk(), storage);
}
