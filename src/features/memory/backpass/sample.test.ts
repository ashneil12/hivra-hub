import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET,
  MAX_SAMPLE_BYTES,
  charsPerChat,
  estimateRun,
  projectOf,
  sampleChats,
  sampleOrder,
  type SampleChat,
} from "./sample";

let n = 0;
function chat(project: string, mtimeMs: number, extra: Partial<SampleChat> = {}): SampleChat {
  n += 1;
  return {
    id: `c${n}`,
    source: "claude",
    root: "/store",
    rel: `${project}/c${n}.jsonl`,
    bytes: 5_000,
    mtimeMs,
    cwd: `/work/${project}`,
    ...extra,
  };
}

describe("sampleChats", () => {
  it("takes one chat from each project in turn, newest first inside a project", () => {
    const a = [chat("a", 300), chat("a", 200), chat("a", 100)];
    const b = [chat("b", 250), chat("b", 150)];
    const c = [chat("c", 400)];
    const picked = sampleChats([...a, ...b, ...c], { budget: 10 });
    expect(picked.map((item) => item.mtimeMs)).toEqual([400, 300, 250, 200, 150, 100]);
    // The first round holds one chat of every project.
    expect(picked.slice(0, 3).map((item) => item.cwd)).toEqual(["/work/c", "/work/a", "/work/b"]);
  });

  it("keeps a busy project from crowding out the others", () => {
    const busy = Array.from({ length: 100 }, (_, index) => chat("busy", 10_000 - index));
    const quiet = [chat("quiet", 5), chat("other", 4)];
    const picked = sampleChats([...busy, ...quiet], { budget: 6 });
    const projects = new Set(picked.map((item) => item.cwd));
    expect(projects).toEqual(new Set(["/work/busy", "/work/quiet", "/work/other"]));
    expect(picked).toHaveLength(6);
  });

  it("stops at the budget, which is about sixty chats by default", () => {
    const many = Array.from({ length: 500 }, (_, index) => chat(`p${index % 40}`, 1_000 + index));
    expect(DEFAULT_BUDGET).toBe(60);
    expect(sampleChats(many)).toHaveLength(60);
    expect(sampleChats(many, { budget: 7 })).toHaveLength(7);
    expect(sampleChats(many, { budget: 0 })).toHaveLength(0);
  });

  it("drops chats before the from-date and keeps those at it", () => {
    const old = chat("a", 100);
    const edge = chat("a", 500);
    const fresh = chat("b", 900);
    const picked = sampleChats([old, edge, fresh], { fromMs: 500 });
    expect(picked.map((item) => item.id).sort()).toEqual([edge.id, fresh.id].sort());
  });

  it("keeps only the named projects, matching sub-folders and Claude's folder names", () => {
    const hub = chat("hub", 100, { cwd: "/work/hub" });
    const sub = chat("hub", 200, { cwd: "/work/hub/app" });
    const sibling = chat("hubble", 300, { cwd: "/work/hubble" });
    const claudeOnly = chat("x", 400, { cwd: null, rel: "-work-hub/abc.jsonl" });
    const elsewhere = chat("other", 500, { cwd: null, rel: "-work-other/abc.jsonl" });
    const picked = sampleChats([hub, sub, sibling, claudeOnly, elsewhere], { projects: ["/work/hub/"] });
    expect(picked.map((item) => item.id).sort()).toEqual([hub.id, sub.id, claudeOnly.id].sort());
  });

  it("skips a chat with almost nothing in it", () => {
    const tiny = chat("a", 900, { bytes: 120 });
    const known = chat("a", 800, { userMessages: 1 });
    const fine = chat("a", 700, { userMessages: 3 });
    const open = chat("b", 600, { source: "opencode", bytes: 0 });
    const picked = sampleChats([tiny, known, fine, open]);
    expect(picked.map((item) => item.id).sort()).toEqual([fine.id, open.id].sort());
  });

  it("counts a file too big to sample instead of reading it", () => {
    const huge = chat("a", 900, { bytes: MAX_SAMPLE_BYTES + 1 });
    const fine = chat("a", 800);
    const plan = sampleOrder([huge, fine]);
    expect(plan.order.map((item) => item.id)).toEqual([fine.id]);
    expect(plan.tooBig).toBe(1);
  });

  it("lists each chat once and ignores rows that are not chats", () => {
    const one = chat("a", 100);
    const bad = { id: 3, root: null } as unknown as SampleChat;
    expect(sampleChats([one, { ...one }, bad])).toHaveLength(1);
  });

  it("gives the same order every time", () => {
    const all = [chat("a", 5), chat("b", 5), chat("c", 5), chat("a", 5)];
    expect(sampleOrder(all).order.map((item) => item.id)).toEqual(sampleOrder([...all].reverse()).order.map((item) => item.id));
  });

  it("takes nothing from nothing", () => {
    expect(sampleChats([])).toEqual([]);
  });
});

describe("projectOf", () => {
  it("uses the folder, then Claude's project folder, then the store", () => {
    expect(projectOf({ source: "codex", cwd: "/work/hub/", rel: "2026/11/x.jsonl" })).toBe("/work/hub");
    expect(projectOf({ source: "claude", cwd: null, rel: "-work-hub/a.jsonl" })).toBe("claude:-work-hub");
    expect(projectOf({ source: "codex", cwd: null, rel: "2026/11/x.jsonl" })).toBe("store:codex");
  });
});

describe("the size of a run", () => {
  it("gives each chat an even share of the text, between a floor and a ceiling", () => {
    expect(charsPerChat(1)).toBe(8_000);
    expect(charsPerChat(60)).toBe(5_000);
    expect(charsPerChat(10_000)).toBe(2_500);
  });

  it("estimates a ceiling in tokens from sizes, never past a chat's share", () => {
    const small = estimateRun([{ bytes: 400 }]);
    expect(small).toEqual({ chats: 1, tokens: 100 });
    const big = estimateRun(Array.from({ length: 60 }, () => ({ bytes: 20_000_000 })));
    expect(big.chats).toBe(60);
    expect(big.tokens).toBe(60 * 1_250);
    expect(estimateRun([])).toEqual({ chats: 0, tokens: 0 });
  });
});
