// Tests only. The app's own local hub (WP-04) on an in-memory disk, with the four example projects the old stub had, and
// a log of every call the store makes. Never shipped: nothing in the app imports it.
import type { Delegation } from "../features/monos/model/delegations";
import { delegationDecisions } from "../features/hub/model/localHub/decisions";
import { LocalHub, memoryDisk, type LocalHubState } from "../features/hub/model/localHub/localHub";
import { createLocalTransport } from "../features/hub/model/localHub/localTransport";
import type { HubTransport } from "../features/hub/model/hubTransport";

export const EXAMPLE_PROJECTS = [
  { project_id: "vg-game", name: "EXO", short_name: "EXO", icon_shape: "gamepad", folder: "/Users/example/Projects/vg-game" },
  { project_id: "hivra", name: "Hivra", short_name: "Hivra", icon_shape: "sparkles", folder: "/Users/example/Projects/hivra" },
  { project_id: "nibbii", name: "Nibbii", short_name: "Nibbii", icon_shape: "heart", folder: "/Users/example/Projects/nibbii" },
  { project_id: "hub", name: "MonoCode Hub", short_name: "Hub", icon_shape: "code", folder: "/Users/example/Projects/monocode-hub" },
];

export type TestHub = {
  hub: LocalHub;
  transport: HubTransport;
  /** Every action the store called, in order. */
  calls: string[];
  /** What the local store holds right now. */
  state(): Promise<LocalHubState>;
};

export async function localTestHub(options: { projects?: boolean; open?: () => Delegation[] } = {}): Promise<TestHub> {
  const hub = new LocalHub(memoryDisk());
  if (options.projects !== false) for (const p of EXAMPLE_PROJECTS) await hub.projectCreate(p);
  const inner = createLocalTransport(hub, delegationDecisions(async () => options.open?.() ?? []));
  const calls: string[] = [];
  const transport: HubTransport = {
    call: (action, payload) => {
      calls.push(action);
      return inner.call(action, payload);
    },
    openFeed: (after, handlers) => inner.openFeed(after, handlers),
  };
  return { hub, transport, calls, state: () => hub.snapshot() };
}
