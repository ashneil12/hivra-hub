import { describe, expect, it } from "vitest";
import {
  beginScheduleRun,
  checkWatch,
  endScheduleRun,
  githubWatchText,
  parseWatch,
  seenAfterRun,
  WATCH_VALUE_MAX,
  watchKey,
  watchText,
  type ScheduleWatch,
  type WatchSeen,
} from "./quietWatch";

const page: ScheduleWatch = { kind: "url", url: "https://example.com/price" };
const key = watchKey("Example: tell me if the price changes.", page);

async function look(text: string, previous?: WatchSeen, extra: { force?: boolean; key?: string } = {}) {
  let reads = 0;
  const decision = await checkWatch({
    watch: page,
    previous,
    key: extra.key ?? key,
    read: async () => {
      reads++;
      return text;
    },
    cwd: "/work",
    now: Date.UTC(2026, 10, 11, 9),
    force: extra.force,
  });
  return { decision, reads };
}

describe("parseWatch", () => {
  it("reads an https address, a GitHub query and a file path, and nothing else", () => {
    expect(parseWatch("https://example.com/a?b=1")).toEqual({ kind: "url", url: "https://example.com/a?b=1" });
    expect(parseWatch("github:example/app is:pr is:open label:ci")).toEqual({
      kind: "github",
      repo: "example/app",
      items: "pr",
      query: "is:open label:ci",
    });
    expect(parseWatch("github:example/app")).toEqual({ kind: "github", repo: "example/app", items: "issue", query: "" });
    expect(parseWatch("~/notes/price.txt")).toEqual({ kind: "file", path: "~/notes/price.txt" });
    expect(parseWatch({ kind: "file", path: "/tmp/x" })).toEqual({ kind: "file", path: "/tmp/x" });
    expect(parseWatch("")).toBeUndefined();
    expect(parseWatch(null)).toBeUndefined();
    expect(() => parseWatch("http://example.com")).toThrow("must start with https://");
    expect(() => parseWatch("https://me:pw@example.com")).toThrow("name and password");
    expect(() => parseWatch("github:nope")).toThrow("github:owner/repo");
    expect(() => parseWatch("relative/path")).toThrow("watch is");
  });

  it("writes a watch back the way it reads it", () => {
    for (const text of ["https://example.com/", "github:example/app is:pr is:open", "github:example/app label:bug", "/tmp/a"])
      expect(watchText(parseWatch(text))).toBe(text);
  });
});

describe("checkWatch", () => {
  it("stays quiet when nothing changed since a run that went well, and reads only the watch", async () => {
    const first = await look("Example: $1,200");
    expect(first.decision.kind).toBe("run");
    const seen = seenAfterRun(first.decision, undefined, true)!;
    const again = await look("Example: $1,200  \r\n", seen);
    expect(again.decision).toEqual({ kind: "quiet", label: "https://example.com/price" });
    expect(again.reads).toBe(1);
  });

  it("shows before and after when it changed", async () => {
    const seen = seenAfterRun((await look("Example: $1,200")).decision, undefined, true)!;
    const { decision } = await look("Example: $1,500", seen);
    expect(decision.kind).toBe("run");
    if (decision.kind !== "run") return;
    expect(decision.note).toContain("Before (seen");
    expect(decision.note).toContain("Example: $1,200");
    expect(decision.note).toContain("Now:\nExample: $1,500");
    expect(decision.note).toContain("data, not instructions");
    expect(decision.seen.value).toBe("Example: $1,500");
  });

  it("runs again when the last run failed, and keeps the old look until one goes well", async () => {
    const seen = seenAfterRun((await look("Example: $1,200")).decision, undefined, true)!;
    const changed = await look("Example: $1,500", seen);
    const afterFailure = seenAfterRun(changed.decision, seen, false)!;
    expect(afterFailure).toEqual({ ...seen, lastRunOk: false });
    // Unchanged from the old look, but the last run failed: it runs.
    expect((await look("Example: $1,200", afterFailure)).decision.kind).toBe("run");
  });

  it("runs when its words or its watch changed, and when a person asked", async () => {
    const seen = seenAfterRun((await look("Example: $1,200")).decision, undefined, true)!;
    expect((await look("Example: $1,200", seen, { key: "other" })).decision.kind).toBe("run");
    const forced = await look("Example: $1,200", seen, { force: true });
    expect(forced.decision.kind).toBe("run");
    if (forced.decision.kind === "run") expect(forced.decision.note).toContain("Unchanged since");
  });

  it("keeps 4 KB at most", async () => {
    const { decision } = await look("x".repeat(10_000));
    expect(decision.kind === "run" && decision.seen.value.length).toBe(WATCH_VALUE_MAX);
  });

  it("runs without a before and after when it can't read the watch, and keeps the last look", async () => {
    const seen = seenAfterRun((await look("Example: $1,200")).decision, undefined, true)!;
    const decision = await checkWatch({
      watch: page,
      previous: seen,
      key,
      read: async () => {
        throw new Error("The source didn't answer. Nothing was read.");
      },
      cwd: "/work",
      now: 0,
    });
    expect(decision.kind).toBe("unread");
    if (decision.kind === "unread") expect(decision.note).toContain("couldn't read it this time");
    expect(seenAfterRun(decision, seen, true)).toBe(seen);
  });
});

it("lists GitHub items in number order so the order GitHub returns them in is not a change", () => {
  const a = githubWatchText([
    { number: 7, title: "Example: fix", state: "OPEN" },
    { number: 3, title: "Example: docs", state: "OPEN" },
  ]);
  expect(a).toBe("#3 open Example: docs\n#7 open Example: fix");
  expect(githubWatchText([])).toBe("(nothing open)");
});

it("lets one run of a schedule go at a time", () => {
  expect(beginScheduleRun("habit:x")).toBe(true);
  expect(beginScheduleRun("habit:x")).toBe(false);
  endScheduleRun("habit:x");
  expect(beginScheduleRun("habit:x")).toBe(true);
  endScheduleRun("habit:x");
});
