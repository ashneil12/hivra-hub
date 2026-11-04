// The app's hub transport (WP-04): every hub read and write is answered here, in the app, from its own store
// (localHub.ts) and the decision seam (decisions.ts). Nothing leaves the Mac. The retired Ash OS bridge answered the
// same calls with a prefix; the names below are those calls without it, so the store's readers kept their
// shapes. A call the bridge had and the app no longer makes (the Today ledger, Since, the change feed, building a page
// or changing the hub through Ash OS) is refused in plain words.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tauriDelegations } from "../../../monos/model/delegations";
import { HubCallError, type HubFeedHandlers, type HubTransport } from "../hubTransport";
import { delegationDecisions, isDecisionAction, type DecisionSource } from "./decisions";
import { DECISIONS_CHANGED, tauriFirstMate } from "../../../firstmate/model/steering";
import { LocalHub, memoryDisk, type LocalHubDisk } from "./localHub";

type Payload = Record<string, unknown>;

/** The app's database, through the hub plugin (src-tauri/src/local_hub.rs). */
export const tauriLocalHubDisk: LocalHubDisk = {
  read: async (key) => (await tauriLocalHubDisk.readDoc(key)).value,
  readDoc: async (key) => {
    const doc = await invoke<{ value: unknown; rev: number }>("plugin:hub|local_hub_read", { key });
    return { value: doc?.value ?? null, rev: typeof doc?.rev === "number" ? doc.rev : 0 };
  },
  write: (key, value, rev) => invoke<number | null>("plugin:hub|local_hub_write", { key, value, expectRev: rev ?? null }),
  // Every window hears every write (local_hub.rs CHANGED_EVENT), its own included; LocalHub skips revisions it knows.
  watch: (onChange) => {
    let stop: (() => void) | undefined;
    let stopped = false;
    void listen<{ key?: unknown; rev?: unknown }>(LOCAL_HUB_CHANGED, ({ payload }) => {
      if (typeof payload?.key === "string" && typeof payload.rev === "number") onChange(payload.key, payload.rev);
    })
      .then((unlisten) => (stopped ? unlisten() : (stop = unlisten)))
      .catch(() => undefined);
    return () => {
      stopped = true;
      stop?.();
    };
  },
};

/** The event local_hub.rs sends to every window after a write. */
export const LOCAL_HUB_CHANGED = "local-hub://changed";

export function createLocalTransport(hub: LocalHub, decisions: DecisionSource): HubTransport & { hub: LocalHub } {
  let seq = 0;
  const feeds = new Set<HubFeedHandlers>();
  const changed = (kind: string, topics: string[]) => {
    seq += 1;
    const event = { seq, kind, ref: null, topics, at: new Date().toISOString() };
    for (const f of [...feeds]) f.onEvent(event);
  };
  // Any change to the record (a tap, the import) reads projects, the strip and Pages again.
  hub.onChange(() => changed("hub.local.changed", ["projects", "layout", "pages"]));
  // Hivra WP-14: a decision asked or answered reads the Needs (and the jobs it released) again.
  decisions.onChange?.(() => changed("decisions.changed", ["needs", "jobs"]));

  const answer = async (action: string, v: Payload): Promise<unknown> => {
    switch (action) {
      case "projects":
        return { ...(await hub.projects(v)), seq };
      case "project-create":
        return hub.projectCreate(v);
      case "project-rename":
        return hub.projectRename(v);
      case "project-archive":
        return hub.projectArchive(v);
      case "mono-project-add":
        return hub.monoProjectAdd(v);
      case "mono-project-remove":
        return hub.monoProjectRemove(v);
      case "mono-projects":
        return hub.monoProjects(v);
      case "pages":
        return { ...(await hub.pages(v)), seq };
      case "page-update":
        return hub.pageUpdate(v);
      case "page-remove":
        return hub.pageRemove(v);
      case "layout":
        return { ...(await hub.layout()), seq };
      case "needs":
        return { ...(obj(await decisions.needs())), seq };
      case "jobs":
        return { ...(obj(await decisions.jobs())), seq };
      case "checks":
        return decisions.checks();
      default:
        if (isDecisionAction(action)) return decisions.act(action, v);
        throw new HubCallError("refused", "The app doesn't do that any more.");
    }
  };

  return {
    hub,
    async call<T>(action: string, payload: Payload = {}): Promise<T> {
      try {
        return (await answer(action, payload)) as T;
      } catch (error) {
        if (error instanceof HubCallError) throw error;
        // A refusal in the store's own words ("project exo already exists"): Ash said something it can't take.
        throw new HubCallError("error", error instanceof Error ? error.message : String(error));
      }
    },
    openFeed(_after, handlers) {
      feeds.add(handlers);
      queueMicrotask(() => feeds.has(handlers) && handlers.onState({ connected: true, latest: seq }));
      return () => void feeds.delete(handlers);
    },
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

let app: (HubTransport & { hub: LocalHub }) | undefined;

/**
 * The app's one transport: the app's database inside Tauri, memory in a plain browser (the preview pages, where
 * `invoke` isn't there). Made on first use.
 */
export function appHubTransport(): HubTransport & { hub: LocalHub } {
  if (!app) {
    const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    const disk = inTauri ? tauriLocalHubDisk : memoryDisk();
    app = createLocalTransport(new LocalHub(disk), delegationDecisions(
      () => (inTauri ? tauriDelegations.listOpen() : Promise.resolve([])),
      // Hivra WP-14: open decisions are the Needs rows.
      inTauri ? tauriFirstMate : undefined,
      inTauri ? (fn) => void listen(DECISIONS_CHANGED, fn).catch(() => undefined) : undefined,
    ));
  }
  return app;
}

/** Tests only: forget the app transport. */
export function resetAppHubTransportForTest(): void {
  app = undefined;
}
