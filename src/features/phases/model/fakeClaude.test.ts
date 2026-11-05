import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { begin, counter, running } from "./machine";
import { fakeClaudeLaunch, finishFromFake, phasePrompt } from "./fakeClaude";
import { skillText } from "./skillText";

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

it("gives the fake Claude only the scenario and the state directory", () => {
  const previous = process.env.SECRET_TOKEN;
  process.env.SECRET_TOKEN = "nope";
  try {
    const launch = fakeClaudeLaunch("/tmp/rules.json", "/tmp/state", "phase-1");
    expect(launch.env.FAKE_CLAUDE_SCENARIO).toBe("/tmp/rules.json");
    expect(launch.env.FAKE_CLAUDE_STATE).toBe("/tmp/state");
    expect(launch.env.SECRET_TOKEN).toBeUndefined();
    expect(Object.keys(launch.env).sort()).toEqual(["FAKE_CLAUDE_SCENARIO", "FAKE_CLAUDE_STATE"]);
  } finally {
    if (previous === undefined) delete process.env.SECRET_TOKEN;
    else process.env.SECRET_TOKEN = previous;
  }
});

it("puts the iterate skill's own text in the prompt", () => {
  const text = skillText("iterate-design");
  expect(text).toContain("You are iterating on an existing design discussion document based on user feedback.");
  const ids = counter();
  const work = begin("task-4", { weight: "costly" }, {}, ids);
  const run = running(work);
  if (!run) throw new Error("no run");
  const prompt = phasePrompt(work, { ...run, skill: "iterate-design", steering: ["use the queue"] }, text);
  expect(prompt).toContain("You are iterating on an existing design discussion document based on user feedback.");
  expect(prompt).toContain("use the queue");
  expect(prompt).toContain("Skill: iterate-design");
});
