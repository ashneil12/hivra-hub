// @vitest-environment happy-dom
// Point 13: every Mono has its own chat, memory and rules. The backend keeps each Mono's SOUL.md and MEMORY.md in
// <app data>/monos/<mono id>/ (src-tauri/src/mono.rs, which has the same checks against the real files); here a fake
// disk stands in for those commands so the app's own read/write path is checked end to end, through a "restart".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Map<string, string>();
const hash = (t: string) => `h${t.length}:${[...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
const invoke = vi.fn(async (cmd: string, args: { mono: string; path?: string; text?: string; expectedHash?: string | null }) => {
  const at = (p: string) => `${args.mono}/${p}`;
  if (cmd === "mono_load") {
    const soul = disk.get(at("SOUL.md")) ?? null;
    const memory = disk.get(at("MEMORY.md")) ?? "";
    return { id: args.mono, dir: `/data/monos/${args.mono}`, soul, soulHash: hash(soul ?? ""), memory, memoryHash: hash(memory), memoryPath: `/data/monos/${args.mono}/MEMORY.md`, topics: [] };
  }
  if (cmd === "mono_read") {
    const text = disk.get(at(args.path!)) ?? null;
    return { text, hash: hash(text ?? "") };
  }
  if (cmd === "mono_save") {
    const current = disk.get(at(args.path!)) ?? "";
    if (args.expectedHash != null && args.expectedHash !== hash(current)) throw "conflict";
    disk.set(at(args.path!), args.text!);
    return hash(args.text!);
  }
  throw new Error(`unexpected ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: never) => invoke(cmd, args) }));

const stored = new Map<string, string>();
beforeEach(() => {
  disk.clear();
  stored.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

/** A fresh copy of the app's modules over the same disk and storage: what a restart is. */
async function boot() {
  const mono = await import("./mono");
  const files = await import("./monoFiles");
  return { ...mono, ...files };
}

async function threeMonos() {
  const app = await boot();
  for (const id of ["mono-a", "mono-b", "mono-c"]) app.addMono({ id, name: id.toUpperCase(), mascot: "robot", color: "x", projects: [] });
  for (const id of ["mono-a", "mono-b", "mono-c"]) app.saveMonoSessionId(id, `chat-${id}`);
  return app;
}

describe("point 13: each Mono keeps its own chat, memory and rules", () => {
  it("1. a fact told to Mono A is still there after a restart, and B and C never see it", async () => {
    const before = await threeMonos();
    await before.editMonoFile("mono-a", "memory", (t) => `${t}- 2026-10-15 · the launch is on Friday\n`);

    const after = await boot();
    expect((await after.loadMonoFiles("mono-a")).memory).toContain("the launch is on Friday");
    expect((await after.loadMonoFiles("mono-b")).memory).toBe("");
    expect((await after.loadMonoFiles("mono-c")).memory).toBe("");
    // each still has its own conversation after the restart
    expect(after.listMonos().map((m) => [m.id, m.sessionId])).toEqual([
      ["mono-a", "chat-mono-a"], ["mono-b", "chat-mono-b"], ["mono-c", "chat-mono-c"],
    ]);
    expect(after.monoForSession("chat-mono-b")?.id).toBe("mono-b");
  });

  it("2. changing Mono A's rules leaves B's and C's rules unchanged", async () => {
    const app = await threeMonos();
    const souls = async () => Promise.all(["mono-a", "mono-b", "mono-c"].map(async (id) => (await app.loadMonoFiles(id)).soul));
    const [, b0, c0] = await souls();
    const a = await app.loadMonoFiles("mono-a");
    await app.saveMonoFile("mono-a", "soul", "# Soul\n\n## Standing instructions\n- Always answer in French\n", a.soulHash);
    const [a1, b1, c1] = await souls();
    expect(a1).toContain("Always answer in French");
    expect(b1).toBe(b0);
    expect(c1).toBe(c0);
    expect(b1).not.toContain("French");
    // and nothing outside A's folder was written
    expect([...disk.keys()].filter((k) => k.includes("French") || disk.get(k)!.includes("French"))).toEqual(["mono-a/SOUL.md"]);
  });

  it("leak fix: two Monos can never share one conversation (which would send B's memory writes to A)", async () => {
    const app = await threeMonos();
    // B asking for A's chat is refused
    app.saveMonoSessionId("mono-b", "chat-mono-a");
    expect(app.findMono("mono-b")?.sessionId).toBe("chat-mono-b");
    // a roster that names one chat twice (old copy, restored file) keeps it for the first Mono only
    const roster = JSON.parse(stored.get("monocode:mono-roster")!) as { id: string; sessionId?: string }[];
    roster[2].sessionId = "chat-mono-a";
    stored.set("monocode:mono-roster", JSON.stringify(roster));
    const after = await boot();
    expect(after.findMono("mono-c")?.sessionId).toBeUndefined();
    expect(after.monoForSession("chat-mono-a")?.id).toBe("mono-a");
  });
});
