import { spawnSync } from "node:child_process";
import { realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { RPI_SKILL_NAMES } from "./indexGuard";
import { PHASE_PREAMBLE, phasePrompt, promptForPhase, skillNameFor } from "./phasePrompt";

const phases = [
  "product",
  "technical",
  "research-questions",
  "research",
  "design",
  "outline",
  "build",
] as const;

it("tells every phase there is no artifact directory and the reply is the document", () => {
  expect(PHASE_PREAMBLE).toContain("There is no artifact directory");
  expect(PHASE_PREAMBLE).toContain("The query is the task, the person's words and the earlier documents.");
  expect(PHASE_PREAMBLE).toContain("Never wait for the user.");
  expect(PHASE_PREAMBLE).toContain("Put open questions in the document instead.");
  expect(PHASE_PREAMBLE).toContain("The reply is the document.");
  for (const phase of phases) {
    const skill = skillNameFor(phase);
    expect(skill, phase).toBeTruthy();
    const prompt = phasePrompt(
      {
        taskId: "task-1",
        path: "research-plan-build",
        docs: [{ number: 1, title: "Research", body: "A fact." }],
      },
      { skill: skill!, steering: ["use the queue"], docNumber: phase === "design" ? 2 : undefined },
      "SKILL BODY",
      "/tmp/code base",
    );
    expect(prompt.startsWith(PHASE_PREAMBLE), phase).toBe(true);
    expect(prompt.indexOf(PHASE_PREAMBLE), phase).toBeLessThan(prompt.indexOf("SKILL BODY"));
    expect(prompt, phase).toContain("The code is in /tmp/code base.");
    expect(prompt, phase).toContain("not an artifact directory");
    expect(prompt, phase).toContain(`Skill: ${skill}`);
    expect(prompt, phase).toContain("Task: task-1");
    expect(prompt, phase).toContain("use the queue");
    expect(prompt, phase).toContain("## Research\nA fact.");
  }
  for (const skill of RPI_SKILL_NAMES) {
    const prompt = phasePrompt(
      { taskId: "task-1", path: "research-plan-build", docs: [] },
      { skill, steering: [] },
      "SKILL BODY",
    );
    expect(prompt.startsWith(PHASE_PREAMBLE), skill).toBe(true);
    expect(prompt, skill).not.toContain("The code is in");
  }
});

it("names a phase's skill and refuses a path", () => {
  expect(skillNameFor("design")).toBe("design-discussion");
  expect(skillNameFor("Design")).toBe("design-discussion");
  expect(skillNameFor("build")).toBe("implement-outline");
  expect(skillNameFor("iterate-design")).toBe("iterate-design");
  expect(skillNameFor("../research")).toBeUndefined();
  expect(skillNameFor("research questions")).toBeUndefined();
  expect(skillNameFor("")).toBeUndefined();
  expect(promptForPhase("nope", "   ", "/tmp/repo", "body")).toBeUndefined();
});

it("prints the same prompt the app builds", () => {
  const repo = realpathSync(resolve("."));
  const task = "The save drops the last line.";
  const text = readFileSync(resolve(repo, "src-tauri/plugins/hivra-rpi/skills/research/SKILL.md"), "utf8");
  const expected = promptForPhase("research", task, repo, text);
  expect(expected?.startsWith(PHASE_PREAMBLE)).toBe(true);
  expect(expected).toContain("You are creating a technical map/documentation of the existing system");
  const run = spawnSync(
    process.execPath,
    ["scripts/rpi-phase-prompt.mjs", "--phase", "research", "--task", task, "--repo", repo],
    { encoding: "utf8" },
  );
  expect(run.status).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toBe(`${expected}\n`);
});
