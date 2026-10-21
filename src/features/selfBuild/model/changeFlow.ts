import { useSyncExternalStore } from "react";
import { recordFlowChange, setFlowHooks } from "../../hub/model/botChanges";

/**
 * One way to show Ash a change before it goes in (ash-day steps 14 and 15, and themes): a kind registers how its
 * change is previewed, applied, thrown away and undone; `offerChange` puts one in front of Ash (the bar at the
 * bottom of the window: Now | Preview, Apply, Discard). Apply leaves one Bot changes row per part, each with its own
 * Undo and Redo, so "undo that colour" takes out only the colour. The handlers survive a restart because a row keeps
 * only its kind and data; the kind's code does the work.
 *
 * Contract for other lanes (themes): /workspace/hub-takeover/self-build-api.md.
 */
export type ChangePart = {
  /** Plain words Ash reads in Bot changes: "Accent is a bit more purple". */
  title: string;
  /** What the kind needs to undo this part later (JSON). */
  data: unknown;
};
export type ChangeKind = {
  /** Show the change in the live app (on) or take it back out (off). Optional: a kind may show its own preview. */
  preview?(data: unknown, on: boolean): Promise<void>;
  /** Put it in for good. Returns its parts, each undone on its own. Throws Ash's plain reason when it can't. */
  apply(data: unknown): Promise<ChangePart[]>;
  /** Throw it away; the app is as it was. */
  discard?(data: unknown): Promise<void>;
  /** Undo one applied part; returns what redo needs (JSON). */
  undo(part: unknown): Promise<unknown>;
  /** Put an undone part back, from what undo returned. */
  redo(part: unknown, undone: unknown): Promise<void>;
};
export type OfferedChange = {
  id: string;
  kind: string;
  /** One line: what the change does. */
  title: string;
  /** The Mono that made it (its name), shown as "from …" and as the Bot changes row's bot. */
  by: string;
  data: unknown;
  /** The parts as they will land, shown under the title. */
  parts?: string[];
  /** Already showing (a reloaded window picking a live preview back up). */
  previewing?: boolean;
};
type Offer = OfferedChange & { previewing: boolean; busy?: boolean; problem?: string };

const kinds = new Map<string, ChangeKind>();
let offers: Offer[] = [];
let version = 0;
const subs = new Set<() => void>();
const changed = () => {
  version++;
  subs.forEach((f) => f());
};

export function registerChangeKind(kind: string, handlers: ChangeKind): void {
  kinds.set(kind, handlers);
}
function kindOf(name: string): ChangeKind {
  const kind = kinds.get(name);
  if (!kind) throw new Error("This kind of change isn't available in this build.");
  return kind;
}

/** Put a change in front of Ash: Now | Preview, Apply, Discard. The same id again replaces it. */
export function offerChange(change: OfferedChange): void {
  kindOf(change.kind);
  offers = [...offers.filter((o) => o.id !== change.id), { ...change, previewing: change.previewing ?? false }];
  changed();
}
export function offeredChanges(): readonly Offer[] {
  return offers;
}
export function useOfferedChanges(): readonly Offer[] {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return offers;
}

async function step(id: string, work: (o: Offer, kind: ChangeKind) => Promise<Partial<Offer> | "done">): Promise<string | undefined> {
  const offer = offers.find((o) => o.id === id);
  if (!offer || offer.busy) return offer ? undefined : "That change isn't waiting any more.";
  offers = offers.map((o) => (o.id === id ? { ...o, busy: true, problem: undefined } : o));
  changed();
  try {
    const next = await work(offer, kindOf(offer.kind));
    offers = next === "done" ? offers.filter((o) => o.id !== id) : offers.map((o) => (o.id === id ? { ...o, ...next, busy: false } : o));
    return undefined;
  } catch (e) {
    const problem = e instanceof Error ? e.message : String(e);
    offers = offers.map((o) => (o.id === id ? { ...o, busy: false, problem } : o));
    return problem;
  } finally {
    changed();
  }
}

/** Now (false) or Preview (true). Resolves to Ash's plain reason when it couldn't. */
export function showPreview(id: string, on: boolean): Promise<string | undefined> {
  return step(id, async (o, kind) => {
    if (kind.preview && o.previewing !== on) await kind.preview(o.data, on);
    return { previewing: on };
  });
}
/** Apply: in for good, one Bot changes row per part. */
export function applyOffered(id: string): Promise<string | undefined> {
  return step(id, async (o, kind) => {
    const parts = await kind.apply(o.data);
    for (const part of parts) recordFlowChange({ kind: o.kind, by: o.by, title: part.title, data: part.data });
    return "done";
  });
}
/** Discard: the app is as it was. */
export function discardOffered(id: string): Promise<string | undefined> {
  return step(id, async (o, kind) => {
    if (o.previewing && kind.preview) await kind.preview(o.data, false);
    await kind.discard?.(o.data);
    return "done";
  });
}

setFlowHooks({
  undo: (kind, data) => kindOf(kind).undo(data),
  redo: (kind, data, undone) => kindOf(kind).redo(data, undone),
});

/** Tests only. */
export function resetChangeFlowForTests(): void {
  offers = [];
  changed();
}
