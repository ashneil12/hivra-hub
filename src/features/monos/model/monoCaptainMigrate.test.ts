// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { CAPTAIN_CHARTER } from "../../chief/model/charter";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const ROSTER_KEY = "monocode:mono-roster";
const MONOS_CHANGED = "monocode:monos-changed";

function chartered(): Record<string, unknown> {
  return {
    id: "ada",
    name: "Ada",
    mascot: "letter",
    color: "x",
    projects: [],
    instructions: `# Soul\n\n## Role\n${CAPTAIN_CHARTER}\n`,
  };
}

it("flags a chartered soul once, through the roster save, so the home file and the change event happen", async () => {
  const stored = new Map<string, string>();
  let reads = 0;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (key === ROSTER_KEY) reads += 1;
      return stored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  const saves: string[] = [];
  const home = await import("./monoHome");
  home.resetHomeForTests(false);
  home.setHomeBackend({
    loadRoster: async () => ({ text: null, hash: "h:" }),
    saveRoster: async (text) => {
      saves.push(text);
      return "h:1";
    },
    readChats: async () => ({ text: null, hash: "h:" }),
    saveChats: async () => "h:",
  });
  await home.hydrateRosterFromHome();
  stored.set(ROSTER_KEY, JSON.stringify([chartered()]));
  const events: Event[] = [];
  window.addEventListener(MONOS_CHANGED, (event) => events.push(event));
  const mono = await import("./mono");
  expect(mono.listMonos()[0]?.captain).toBe(true);
  await home.rosterWritesSettled();
  expect(saves.some((text) => text.includes('"captain": true'))).toBe(true);
  expect(events).toHaveLength(1);
  const written = JSON.parse(stored.get(ROSTER_KEY) ?? "[]") as { captain?: boolean }[];
  expect(written[0]?.captain).toBe(true);
  const after = reads;
  mono.listMonos();
  mono.listMonos();
  await home.rosterWritesSettled();
  expect(saves).toHaveLength(1);
  expect(events).toHaveLength(1);
  // Each later read lists the roster once. The migration does not parse it again.
  expect(reads).toBe(after + 2);
});

it("tries the captain flag again when the roster write does not stick", async () => {
  const stored = new Map<string, string>([[ROSTER_KEY, JSON.stringify([chartered()])]]);
  let fail = true;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail && key === ROSTER_KEY) throw new Error("full");
      stored.set(key, value);
    },
    removeItem: (key: string) => stored.delete(key),
  });
  const mono = await import("./mono");
  expect(mono.listMonos()[0]?.captain).toBe(true);
  expect(JSON.parse(stored.get(ROSTER_KEY) ?? "[]")[0].captain).toBeUndefined();
  fail = false;
  expect(mono.listMonos()[0]?.captain).toBe(true);
  expect(JSON.parse(stored.get(ROSTER_KEY) ?? "[]")[0].captain).toBe(true);
  const written = stored.get(ROSTER_KEY);
  mono.listMonos();
  expect(stored.get(ROSTER_KEY)).toBe(written);
});
