import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { RPI_SKILL_NAMES } from "./indexGuard";
import { ITERATE_SKILL_FOR_PHASE } from "./machine";
import { PHASE_PREAMBLE, SKILL_FOR_PHASE, phasePrompt, promptForPhase, skillNameFor } from "./phasePrompt";

const phases = [
  "product",
  "technical",
  "research-questions",
  "research",
  "design",
  "outline",
  "build",
] as const;

const TASK = {
  id: "task-1",
  title: "Fix the save",
  description: "The save drops the last line.",
};

it("tells every phase there is no artifact directory, the reply is the document and whose task it is", () => {
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
        taskId: TASK.id,
        path: "research-plan-build",
        docs: [{ number: 1, title: "Research", body: "A fact." }],
        task: { title: TASK.title, description: TASK.description },
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
    expect(prompt, phase).toContain("Title: Fix the save");
    expect(prompt, phase).toContain(TASK.description);
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
    expect(prompt, skill).toContain("Task: task-1");
    expect(prompt, skill).not.toContain("Title:");
  }
});

it("names the structure outline for an outline, and the implementation iterate for a build", () => {
  expect(skillNameFor("outline")).toBe("create-structure-outline");
  expect(skillNameFor("build")).toBe("implement-outline");
  expect(ITERATE_SKILL_FOR_PHASE.outline).toBe("iterate-outline");
  expect(ITERATE_SKILL_FOR_PHASE.build).toBe("iterate-implementation");
});

it("names a phase's skill and refuses a path", () => {
  expect(skillNameFor("design")).toBe("design-discussion");
  expect(skillNameFor("Design")).toBe("design-discussion");
  expect(skillNameFor("build")).toBe("implement-outline");
  expect(skillNameFor("iterate-design")).toBe("iterate-design");
  expect(skillNameFor("../research")).toBeUndefined();
  expect(skillNameFor("research questions")).toBeUndefined();
  expect(skillNameFor("")).toBeUndefined();
  // A skill called by name is a skill. The script checks that the folder is in the plugin.
  expect(promptForPhase("iterate-design", TASK, "/tmp/repo", "body")).toContain("Skill: iterate-design");
  expect(promptForPhase("research", { ...TASK, id: "   " }, "/tmp/repo", "body")).toBeUndefined();
  expect(promptForPhase("research", { ...TASK, title: " ", description: "" }, "/tmp/repo", "body")).toBeUndefined();
  expect(promptForPhase("research", TASK, "   ", "body")).toBeUndefined();
  expect(promptForPhase("../research", TASK, "/tmp/repo", "body")).toBeUndefined();
});

it("names only skills this plugin actually ships, over the whole map", () => {
  const root = resolve("src-tauri/plugins/hivra-rpi/skills");
  for (const [phase, skill] of [...Object.entries(SKILL_FOR_PHASE), ...Object.entries(ITERATE_SKILL_FOR_PHASE)]) {
    expect(existsSync(resolve(root, skill, "SKILL.md")), `${phase} -> ${skill}`).toBe(true);
  }
});

it("prints the same prompt the app builds, from a task record", () => {
  const repo = realpathSync(resolve("."));
  const text = readFileSync(resolve(repo, "src-tauri/plugins/hivra-rpi/skills/research/SKILL.md"), "utf8");
  const expected = promptForPhase("research", TASK, repo, text);
  expect(expected?.startsWith(PHASE_PREAMBLE)).toBe(true);
  expect(expected).toContain("You are creating a technical map/documentation of the existing system");
  expect(expected).toContain("Task: task-1");
  expect(expected).toContain("Title: Fix the save");
  expect(expected).toContain(TASK.description);
  const dir = mkdtempSync(join(tmpdir(), "rpi-record-"));
  try {
    const record = join(dir, "task.json");
    writeFileSync(record, JSON.stringify(TASK));
    const run = spawnSync(
      process.execPath,
      ["scripts/rpi-phase-prompt.mjs", "--phase", "research", "--record", record, "--repo", repo],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`${expected}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
