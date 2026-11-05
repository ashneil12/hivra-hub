import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { begin, counter, running } from "./machine";
import { finishFromFake } from "./fakeClaude";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "hivra-phase-"));
  dirs.push(dir);
  return dir;
}

it("writes the fake Claude's research and retries when it does not answer", async () => {
  const dir = scratch();
  const scenario = join(dir, "rules.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      version: 1,
      rules: [{ name: "research", match: "research-questions", steps: [{ say: "The save drops the last line." }] }],
    }),
  );
  const ids = counter();
  const work = begin("task-4", { weight: "costly" }, {}, ids);
  const run = running(work);
  if (!run) throw new Error("no run");
  const done = await finishFromFake(work, run, scenario, join(dir, "state"), ids);
  expect(done.stale).toBe(false);
  expect(done.work.docs.map((doc) => doc.body)).toEqual(["The save drops the last line."]);

  const slow = join(dir, "slow.json");
  writeFileSync(slow, JSON.stringify({ version: 1, rules: [{ name: "slow", match: "research-questions", steps: [{ sleep: 5_000 }, { say: "too late" }] }] }));
  const again = begin("task-5", { weight: "costly" }, {}, ids);
  const waiting = running(again);
  if (!waiting) throw new Error("no run");
  const retried = await finishFromFake(again, waiting, slow, join(dir, "slow-state"), ids, 400);
  expect(retried.work.docs).toEqual([]);
  expect(retried.work.runs[0]?.status).toBe("retry");
});
