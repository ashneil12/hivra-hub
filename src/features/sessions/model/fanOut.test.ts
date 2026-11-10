import { describe, expect, it } from "vitest";
import {
  FAN_OUT_MAX,
  assignFanOutWorktrees,
  trustedWorktreePath,
  planFanOut,
  replaceFanOutChildren,
  worktreeNote,
  type CompareRecord,
  type FanOutChild,
} from "./fanOut";

const ROOT = "/work/proj";
const POOL = "/work/trees";

function ids(...values: string[]) {
  const left = [...values];
  return { next: () => left.shift() ?? "extra" };
}

function targets(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    provider: index % 2 === 0 ? "claude" : "codex",
    model: `model-${index + 1}`,
  }));
}

function plan(over: Partial<Parameters<typeof planFanOut>[0]> = {}) {
  const result = planFanOut({
    prompt: "Fix the flaky test",
    targets: targets(2),
    ids: ids("compare-1", "child-a", "child-b", "child-c", "child-d"),
    now: 100,
    ...over,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.record;
}

function offer(path: string, branch = "mc/fan") {
  return { path, branch };
}

describe("planFanOut", () => {
  it("keeps one prompt and points a compare record at one child per model", () => {
    const record = plan();
    expect(record.prompt).toBe("Fix the flaky test");
    expect(record.id).toBe("compare-1");
    expect(record.revision).toBe(1);
    expect(record.autoMerge).toBe(false);
    expect(record.winnerId).toBeUndefined();
    expect(record.discardedIds).toEqual([]);
    expect(record.children.map((child) => [child.id, child.provider, child.model])).toEqual([
      ["child-a", "claude", "model-1"],
      ["child-b", "codex", "model-2"],
    ]);
    expect(record.children.every((child) => child.worktree.kind === "pending")).toBe(true);
  });

  it("stores the prompt once, with CRLF turned into LF", () => {
    const record = plan({ prompt: "  line one\r\nline two\r" });
    expect(record.prompt).toBe("line one\nline two");
    expect(record.children).toHaveLength(2);
  });

  it("refuses an empty or missing prompt", () => {
    expect(planFanOut({ prompt: "   \n", targets: targets(2) })).toEqual({
      ok: false,
      code: "empty-prompt",
    });
    expect(planFanOut({ prompt: "", targets: targets(2) }).ok).toBe(false);
  });

  it("refuses one model, because that is an ordinary send", () => {
    const result = planFanOut({ prompt: "hello", targets: targets(1) });
    expect(result).toEqual({ ok: false, code: "too-few", count: 1 });
  });

  it("refuses an empty list and a non-list", () => {
    expect(planFanOut({ prompt: "hello", targets: [] })).toEqual({
      ok: false,
      code: "too-few",
      count: 0,
    });
    const missing = planFanOut({ prompt: "hello", targets: null });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("bad-targets");
  });

  it(`accepts ${FAN_OUT_MAX} models and refuses one more without starting any`, () => {
    const atCap = planFanOut({
      prompt: "hello",
      targets: targets(FAN_OUT_MAX),
      ids: ids("c", "1", "2", "3", "4"),
    });
    expect(atCap.ok).toBe(true);
    if (atCap.ok) expect(atCap.record.children).toHaveLength(FAN_OUT_MAX);

    const over = planFanOut({ prompt: "hello", targets: targets(FAN_OUT_MAX + 1) });
    expect(over).toEqual({ ok: false, code: "over-cap", count: FAN_OUT_MAX + 1, cap: FAN_OUT_MAX });
    expect(FAN_OUT_MAX).toBeLessThanOrEqual(4);
  });

  it("refuses a dozen models even when most of them are blank", () => {
    const dozen = Array.from({ length: 12 }, () => ({ provider: "claude", model: "" }));
    expect(planFanOut({ prompt: "hello", targets: dozen })).toMatchObject({
      ok: false,
      code: "over-cap",
    });
  });

  it("refuses a duplicate provider and model instead of starting it twice", () => {
    const result = planFanOut({
      prompt: "hello",
      targets: [
        { provider: "claude", model: "opus" },
        { provider: "codex", model: "gpt" },
        { provider: "claude", model: " opus " },
      ],
    });
    expect(result).toEqual({ ok: false, code: "duplicate", provider: "claude", model: "opus" });
  });

  it("allows the same model name on two providers", () => {
    const result = planFanOut({
      prompt: "hello",
      targets: [
        { provider: "claude", model: "fast" },
        { provider: "codex", model: "fast" },
      ],
      ids: ids("c", "a", "b"),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an unknown provider, a blank model, and a model that is more than one line", () => {
    expect(
      planFanOut({
        prompt: "hello",
        targets: [
          { provider: "Claude", model: "opus" },
          { provider: "codex", model: "gpt" },
        ],
      }),
    ).toMatchObject({ ok: false, code: "bad-target", index: 0 });
    expect(
      planFanOut({
        prompt: "hello",
        targets: [
          { provider: "claude", model: "   " },
          { provider: "codex", model: "gpt" },
        ],
      }),
    ).toMatchObject({ ok: false, code: "bad-target", index: 0 });
    expect(
      planFanOut({
        prompt: "hello",
        targets: [
          { provider: "claude", model: "opus\n--force" },
          { provider: "codex", model: "gpt" },
        ],
      }),
    ).toMatchObject({ ok: false, code: "bad-target", index: 0 });
  });

  it("gives every child its own id when the generator repeats one", () => {
    const result = planFanOut({
      prompt: "hello",
      targets: targets(2),
      ids: { next: () => "same" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = [result.record.id, ...result.record.children.map((child) => child.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("assignFanOutWorktrees", () => {
  const base = {
    projectRoot: ROOT,
    allowedRoots: [POOL],
  };

  it("gives each child a different worktree inside the allowed folder", () => {
    const record = plan();
    const children = assignFanOutWorktrees(record.children, {
      ...base,
      git: true,
      offers: [
        offer(`${POOL}/one`, "mc/one"),
        offer(`${POOL}/two`, "mc/two"),
      ],
    });
    expect(children.map((child) => child.worktree)).toEqual([
      { kind: "assigned", path: `${POOL}/one`, branch: "mc/one" },
      { kind: "assigned", path: `${POOL}/two`, branch: "mc/two" },
    ]);
    expect(new Set(children.map((child) => child.id))).toEqual(new Set(["child-a", "child-b"]));
  });

  it("leaves the rest in the project folder when there are fewer worktrees than chats", () => {
    const record = plan({
      targets: targets(3),
      ids: ids("c", "a", "b", "d"),
    });
    const children = assignFanOutWorktrees(record.children, {
      ...base,
      git: true,
      offers: [offer(`${POOL}/only`)],
    });
    expect(children[0].worktree).toMatchObject({ kind: "assigned", path: `${POOL}/only` });
    expect(children[1].worktree).toEqual({ kind: "stay", reason: "no-free-worktree" });
    expect(children[2].worktree).toEqual({ kind: "stay", reason: "no-free-worktree" });
    expect(worktreeNote(children[1].worktree)).toMatch(/stays in the project folder/);
    expect(worktreeNote(children[1].worktree)).not.toMatch(/[—–]/);
  });

  it("does not treat a timeout as 'not a git repository'", () => {
    const record = plan();
    const pending = assignFanOutWorktrees(record.children, {
      ...base,
      git: "unknown",
      offers: [offer(`${POOL}/one`), offer(`${POOL}/two`)],
    });
    expect(pending.every((child) => child.worktree.kind === "pending")).toBe(true);
    expect(worktreeNote(pending[0].worktree)).toMatch(/Checking git/);

    const stillPending = assignFanOutWorktrees(pending, {
      ...base,
      git: "unknown",
      offers: [offer(`${POOL}/one`)],
    });
    expect(stillPending.every((child) => child.worktree.kind === "pending")).toBe(true);
  });

  it("assigns after git answers, and stays in the folder when the folder is not a repository", () => {
    const record = plan();
    const pending = assignFanOutWorktrees(record.children, {
      ...base,
      git: "unknown",
      offers: [],
    });
    const assigned = assignFanOutWorktrees(pending, {
      ...base,
      git: true,
      offers: [offer(`${POOL}/one`), offer(`${POOL}/two`)],
    });
    expect(assigned.every((child) => child.worktree.kind === "assigned")).toBe(true);

    const stayed = assignFanOutWorktrees(record.children, {
      ...base,
      git: false,
      offers: [offer(`${POOL}/one`), offer(`${POOL}/two`)],
    });
    expect(stayed.map((child) => child.worktree)).toEqual([
      { kind: "stay", reason: "not-a-repo" },
      { kind: "stay", reason: "not-a-repo" },
    ]);
    expect(worktreeNote(stayed[0].worktree)).toMatch(/not a git repository/);
  });

  it("skips unsafe, duplicate, claimed, and project-root paths", () => {
    const record = plan({
      targets: targets(3),
      ids: ids("c", "a", "b", "d"),
    });
    const children = assignFanOutWorktrees(record.children, {
      ...base,
      git: true,
      claimed: [`${POOL}/taken`],
      offers: [
        offer(`${POOL}/../secret`, "mc/escape"),
        offer(`${POOL}/taken`, "mc/taken"),
        offer(ROOT, "mc/root"),
        offer(`${POOL}-evil/nope`, "mc/prefix"),
        offer(`${POOL}/ok one/ブランチ`, "mc/ok"),
        offer(`${POOL}/ok one/ブランチ`, "mc/dup"),
        offer(""),
        offer(`${POOL}/second`, "mc/two"),
        offer("C:/work/trees/win", "mc/win"),
      ],
    });
    expect(children.map((child) => child.worktree)).toEqual([
      { kind: "assigned", path: `${POOL}/ok one/ブランチ`, branch: "mc/ok" },
      { kind: "assigned", path: `${POOL}/second`, branch: "mc/two" },
      { kind: "stay", reason: "no-free-worktree" },
    ]);
  });

  it("skips the allowed folder itself and a folder that holds the project folder", () => {
    const record = plan({ targets: targets(3), ids: ids("c", "a", "b", "d") });
    const children = assignFanOutWorktrees(record.children, {
      projectRoot: `${POOL}/deep/project`,
      allowedRoots: [POOL],
      git: true,
      offers: [
        offer(POOL, "mc/folder"),
        offer(`${POOL}/deep`, "mc/holder"),
        offer(`${POOL}/deep/project`, "mc/project"),
        offer(`${POOL}/fine`, "mc/fine"),
      ],
    });
    expect(children.map((child) => child.worktree)).toEqual([
      { kind: "assigned", path: `${POOL}/fine`, branch: "mc/fine" },
      { kind: "stay", reason: "no-free-worktree" },
      { kind: "stay", reason: "no-free-worktree" },
    ]);
    expect(trustedWorktreePath(`${POOL}/fine`, ROOT, [POOL])).toBe(true);
    expect(trustedWorktreePath(POOL, ROOT, [POOL])).toBe(false);
    expect(trustedWorktreePath(`${POOL}/fine`, `${POOL}/fine/inside`, [POOL])).toBe(false);
    expect(trustedWorktreePath(`${POOL}/fine`, ROOT, [])).toBe(false);
  });

  it("keeps the commit a worktree was made at, and drops one that is not a commit id", () => {
    const record = plan();
    const children = assignFanOutWorktrees(record.children, {
      ...base,
      git: true,
      offers: [
        { path: `${POOL}/one`, branch: "mc/one", head: "0123abc" },
        { path: `${POOL}/two`, branch: "mc/two", head: "not a commit" },
      ],
    });
    expect(children[0].worktree).toEqual({ kind: "assigned", path: `${POOL}/one`, branch: "mc/one", head: "0123abc" });
    expect(children[1].worktree).toEqual({ kind: "assigned", path: `${POOL}/two`, branch: "mc/two" });
  });

  it("accepts a Windows worktree under an allowed root and ignores a late offer for a child that already has one", () => {
    const record = plan();
    const first = assignFanOutWorktrees(record.children, {
      projectRoot: "C:/work/proj",
      allowedRoots: ["C:/work/trees"],
      git: true,
      offers: [
        offer("C:\\work\\trees\\my folder", "mc/win"),
        offer("C:\\work\\trees\\other", "mc/other"),
      ],
    });
    expect(first[0].worktree).toEqual({
      kind: "assigned",
      path: "C:\\work\\trees\\my folder",
      branch: "mc/win",
    });
    const late = assignFanOutWorktrees(first, {
      projectRoot: "C:/work/proj",
      allowedRoots: ["C:/work/trees"],
      git: true,
      offers: [offer("C:\\work\\trees\\replacement", "mc/new"), offer("C:\\work\\trees\\other", "mc/other")],
    });
    expect(late[0].worktree).toEqual(first[0].worktree);
    expect(late[1].worktree).toEqual(first[1].worktree);
  });

  it("does not let a late 'not a repository' answer take a worktree back", () => {
    const record = plan();
    const assigned = assignFanOutWorktrees(record.children, {
      ...base,
      git: true,
      offers: [offer(`${POOL}/one`), offer(`${POOL}/two`)],
    });
    const late = assignFanOutWorktrees(assigned, {
      ...base,
      git: false,
      offers: [],
    });
    expect(late).toEqual(assigned);
  });

  it("does not assign anything when no folder is allowed", () => {
    const record = plan();
    const children = assignFanOutWorktrees(record.children, {
      projectRoot: ROOT,
      allowedRoots: [],
      git: true,
      offers: [offer(`${POOL}/one`)],
    });
    expect(children[0].worktree).toEqual({ kind: "stay", reason: "no-free-worktree" });
    expect(children[1].worktree).toEqual({ kind: "stay", reason: "no-free-worktree" });
  });
});

describe("replaceFanOutChildren", () => {
  function assigned(record: CompareRecord): FanOutChild[] {
    return assignFanOutWorktrees(record.children, {
      projectRoot: ROOT,
      allowedRoots: [POOL],
      git: true,
      offers: [offer(`${POOL}/one`), offer(`${POOL}/two`)],
    });
  }

  it("writes only on top of the revision it read", () => {
    const record = plan();
    const next = assigned(record);
    const other = assignFanOutWorktrees(record.children, {
      projectRoot: ROOT,
      allowedRoots: [POOL],
      git: false,
      offers: [],
    });
    let stored = record;
    const first = replaceFanOutChildren(stored, record.revision, next);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    stored = first.record;
    const stale = replaceFanOutChildren(stored, record.revision, other);
    expect(stale).toEqual({ ok: false, code: "stale" });
    expect(stored.revision).toBe(2);
    expect(stored.children[0].worktree).toMatchObject({ kind: "assigned" });
    const again = replaceFanOutChildren(stored, record.revision, other);
    expect(again).toEqual({ ok: false, code: "stale" });
    const wiped = replaceFanOutChildren(first.record, first.record.revision, other);
    expect(wiped).toEqual({ ok: false, code: "lost-worktree" });
  });

  it("refuses a write that drops or reorders children", () => {
    const record = plan();
    const swapped = [record.children[1], record.children[0]];
    expect(replaceFanOutChildren(record, record.revision, swapped)).toEqual({
      ok: false,
      code: "children-changed",
    });
    expect(replaceFanOutChildren(record, record.revision, record.children.slice(0, 1))).toEqual({
      ok: false,
      code: "children-changed",
    });
  });
});
