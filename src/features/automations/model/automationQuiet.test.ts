import { afterEach, expect, it, vi } from "vitest";
import { STILL_RUNNING, startAutomationRun } from "./automationQuiet";
import { setWatchDisk, recordAutomationSeen, automationWatch, setAutomationWatch } from "./automationWatches";
import type { WatchReader } from "./quietWatch";

const automation = { id: "price", prompt: "Example: tell me if the price moves.", cwd: "/work" };

function memoryDisk() {
  const docs = new Map<string, { value: unknown; rev: number }>();
  setWatchDisk({
    read: async (key) => docs.get(key) ?? { value: null, rev: 0 },
    write: async (key, value, rev) => {
      const current = docs.get(key)?.rev ?? 0;
      if (current !== rev) return null;
      docs.set(key, { value: JSON.parse(JSON.stringify(value)), rev: current + 1 });
      return current + 1;
    },
  });
}

afterEach(() => setWatchDisk(undefined));

it("makes no model call for an unchanged watch, and runs with before and after once it changed", async () => {
  memoryDisk();
  await setAutomationWatch(automation.id, { kind: "url", url: "https://example.com/price" });
  let price = "Example: $1,200";
  const read: WatchReader = vi.fn(async () => price);

  const first = await startAutomationRun(automation, automation.prompt, { read });
  expect(first.kind).toBe("run");
  if (first.kind !== "run") return;
  expect(first.prompt).toContain("Before: this is the first look.");
  await first.finish(true);

  const quiet = await startAutomationRun(automation, automation.prompt, { read });
  expect(quiet).toEqual({ kind: "skip", reason: "Quiet: https://example.com/price hasn't changed since the last run." });

  price = "Example: $1,500";
  const changed = await startAutomationRun(automation, automation.prompt, { read });
  expect(changed.kind).toBe("run");
  if (changed.kind !== "run") return;
  expect(changed.prompt).toMatch(/Before \(seen [^)]*\):\nExample: \$1,200\nNow:\nExample: \$1,500/);
  await changed.finish(true);
  expect((await automationWatch(automation.id))?.seen?.value).toBe("Example: $1,500");
});

it("runs an automation without a watch as it always did", async () => {
  memoryDisk();
  const read = vi.fn();
  const start = await startAutomationRun(automation, "Example: as typed", { read });
  expect(start.kind === "run" && start.prompt).toBe("Example: as typed");
  expect(read).not.toHaveBeenCalled();
  if (start.kind === "run") await start.finish(true);
});

it("skips a second run while the first is still going, and lets the next one start after", async () => {
  memoryDisk();
  const first = await startAutomationRun(automation, automation.prompt);
  expect(await startAutomationRun(automation, automation.prompt)).toEqual({ kind: "skip", reason: STILL_RUNNING });
  if (first.kind === "run") await first.finish(false);
  const next = await startAutomationRun(automation, automation.prompt);
  expect(next.kind).toBe("run");
  if (next.kind === "run") await next.finish(true);
});

it("a failed run never lets the next one stay quiet", async () => {
  memoryDisk();
  await setAutomationWatch(automation.id, { kind: "file", path: "/tmp/example.txt" });
  const read: WatchReader = async () => "Example: same";
  const first = await startAutomationRun(automation, automation.prompt, { read });
  if (first.kind === "run") await first.finish(false);
  const second = await startAutomationRun(automation, automation.prompt, { read });
  expect(second.kind).toBe("run");
  if (second.kind === "run") await second.finish(true);
});

it("a person's Run now runs even when nothing changed", async () => {
  memoryDisk();
  await setAutomationWatch(automation.id, { kind: "file", path: "/tmp/example.txt" });
  const read: WatchReader = async () => "Example: same";
  const first = await startAutomationRun(automation, automation.prompt, { read });
  if (first.kind === "run") await first.finish(true);
  const manual = await startAutomationRun(automation, automation.prompt, { read }, true);
  expect(manual.kind).toBe("run");
  if (manual.kind === "run") await manual.finish(true);
});

it("changing or clearing the watch starts over, and a record for a removed watch is dropped", async () => {
  memoryDisk();
  await setAutomationWatch(automation.id, { kind: "file", path: "/tmp/a" });
  await recordAutomationSeen(automation.id, { digest: "d", value: "v", at: 1, lastRunOk: true, key: "k" });
  await setAutomationWatch(automation.id, { kind: "file", path: "/tmp/a" });
  expect((await automationWatch(automation.id))?.seen?.value).toBe("v");
  await setAutomationWatch(automation.id, { kind: "file", path: "/tmp/b" });
  expect((await automationWatch(automation.id))?.seen).toBeUndefined();
  await setAutomationWatch(automation.id, undefined);
  await recordAutomationSeen(automation.id, { digest: "d", value: "v", at: 1, lastRunOk: true, key: "k" });
  expect(await automationWatch(automation.id)).toBeUndefined();
});
