import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";
import type { ChatSource } from "./plan";
import { ChatImportRun, type ChatImportPorts, type IndexPage } from "./runner";

const line = (o: unknown) => JSON.stringify(o);
const claude = (id: string, cwd: string, said: string[]) =>
  said
    .map((text, i) =>
      line({ type: "user", sessionId: id, cwd, timestamp: `2026-01-0${i + 1}T10:00:00Z`, message: { role: "user", content: text } }),
    )
    .join("\n");

type Fake = { path: string; cwd: string; id: string; text: string; mtimeMs: number };

function ports(files: Fake[], extra: Partial<ChatImportPorts> = {}) {
  const saved: { session: Session; createdAt: number }[] = [];
  const made: string[] = [];
  const pageSizes: number[] = [];
  const p: ChatImportPorts = {
    roots: async () => ({ claudeCode: ["/h/.claude/projects"], codex: ["/h/.codex/sessions"] }),
    index: async (_root, source: ChatSource, offset, limit): Promise<IndexPage> => {
      if (source === "codex") return { missing: true, total: 0, offset, chats: [], active: 0, links: 0, side: 0, done: true };
      const page = files.slice(offset, offset + limit);
      pageSizes.push(page.length);
      return {
        missing: false,
        total: files.length,
        offset,
        chats: page.map((f) => ({ path: f.path, bytes: f.text.length, mtimeMs: f.mtimeMs, cwd: f.cwd, sessionId: f.id })),
        active: 1,
        links: 0,
        side: 0,
        done: offset + limit >= files.length,
      };
    },
    folders: async (paths) => paths.map((path) => ({ path, exists: !path.startsWith("/gone") })),
    knownIds: async () => ["known"],
    read: async (_root, _source, path) => ({ text: files.find((f) => f.path === path)!.text, cut: false, longLines: 0 }),
    projects: () => [],
    createProject: async (name, folder) => {
      made.push(name);
      return { id: name, name, folder };
    },
    save: async (session, createdAt) => {
      if (saved.some((item) => item.session.id === session.id)) return false;
      saved.push({ session, createdAt });
      return true;
    },
    ...extra,
  };
  return { p, saved, made, pageSizes };
}

const many = (count: number, cwd = "/p/app"): Fake[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `c${i}.jsonl`,
    cwd,
    id: `s${i}`,
    text: claude(`s${i}`, cwd, ["Example: one", "Example: two"]),
    mtimeMs: 1_000_000 - i,
  }));

describe("the chat import run", () => {
  it("pages through every chat with no cap, then brings them in with their projects", async () => {
    const files = many(1203);
    const { p, saved, made, pageSizes } = ports(files);
    const run = new ChatImportRun(p);
    await run.find();
    expect(pageSizes).toEqual([1000, 203]);
    const ready = run.get();
    expect(ready.phase).toBe("ready");
    expect(ready.seen).toBe(1203);
    expect(ready.missing).toEqual(["codex"]);
    expect(ready.groups).toHaveLength(1);
    await run.bringIn();
    const done = run.get();
    expect(done.phase).toBe("done");
    expect(done.imported).toBe(1203);
    expect(made).toEqual(["app"]);
    expect(saved).toHaveLength(1203);
    expect(done.importedIds).toHaveLength(1203);
    expect(done.importedFolders).toEqual(["/p/app"]);
  });

  it("leaves out one-message runs and chats the app already holds, and counts each", async () => {
    const files: Fake[] = [
      { path: "a.jsonl", cwd: "/p/app", id: "a", text: claude("a", "/p/app", ["Example: one", "Example: two"]), mtimeMs: 3 },
      { path: "b.jsonl", cwd: "/p/app", id: "b", text: claude("b", "/p/app", ["Example: only"]), mtimeMs: 2 },
      { path: "k.jsonl", cwd: "/p/app", id: "known", text: claude("known", "/p/app", ["x", "y"]), mtimeMs: 1 },
    ];
    const { p, saved } = ports(files);
    const run = new ChatImportRun(p);
    await run.find();
    expect(run.get().groups[0].chats).toBe(2);
    await run.bringIn();
    expect(saved.map((item) => item.session.id)).toEqual(["imp-claude-a"]);
    expect(run.get().oneShots).toBe(1);
  });

  it("a chat that fails to read is counted and the rest still come in", async () => {
    const files = many(5);
    const { p, saved } = ports(files, {
      read: async (_r, _s, path) => {
        if (path === "c2.jsonl") throw new Error("Could not read this chat.");
        return { text: files.find((f) => f.path === path)!.text, cut: false, longLines: 0 };
      },
    });
    const run = new ChatImportRun(p);
    await run.find();
    await run.bringIn();
    expect(run.get().failed).toBe(1);
    expect(saved).toHaveLength(4);
  });

  it("cancel stops the bringing in, keeping what already came in", async () => {
    const files = many(40);
    let run!: ChatImportRun;
    let reads = 0;
    const { p, saved } = ports(files, {
      read: async (_r, _s, path) => {
        reads += 1;
        if (reads === 6) run.cancel();
        return { text: files.find((f) => f.path === path)!.text, cut: false, longLines: 0 };
      },
    });
    run = new ChatImportRun(p);
    await run.find();
    await run.bringIn();
    expect(run.get().phase).toBe("cancelled");
    expect(saved.length).toBeLessThan(40);
    expect(saved.length).toBeGreaterThan(0);
  });

  it("a gone folder brings nothing in until the person picks a home, and a new start date regroups", async () => {
    const files = [...many(2, "/p/app"), ...many(2, "/gone/app-old").map((f, i) => ({ ...f, path: `g${i}.jsonl`, id: `g${i}`, mtimeMs: 10 }))];
    const { p, saved } = ports(files);
    const run = new ChatImportRun(p);
    await run.find();
    const choices = run.get().choices!;
    expect(choices.groups["/gone/app-old"]).toEqual({ take: true, into: "/p/app" });
    run.choose({ ...choices, fromMs: 100 });
    expect(run.get().groups.map((group) => group.key)).toEqual(["/p/app"]);
    await run.bringIn();
    expect(saved).toHaveLength(2);
  });

  it("tells listeners as it goes", async () => {
    const { p } = ports(many(3));
    const run = new ChatImportRun(p);
    const heard = vi.fn();
    run.subscribe(heard);
    await run.find();
    expect(heard).toHaveBeenCalled();
  });
});
