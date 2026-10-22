// @vitest-environment happy-dom
// ash-day step 16: a worker's self-review becomes one plain lesson in a skill. It applies at once (Ash, 14 Oct),
// lands in Bot changes with Undo, and Undo rewrites the real skill file back.
import { beforeEach, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ files: new Map<string, string>(), dirs: new Set<string>() }));

vi.mock("../../../platform/tauri/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../platform/tauri/fs")>();
  return {
    ...actual,
    homeDir: async () => "/Users/ash",
    readTextFile: async (path: string) => {
      const text = disk.files.get(path);
      if (text === undefined) throw new Error("No such file");
      return text;
    },
    writeTextFile: async (path: string, content: string) => void disk.files.set(path, content),
    createPath: async (parent: string, name: string) => {
      const path = `${parent}/${name}`;
      disk.dirs.add(path);
      return path;
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  disk.files.clear();
  disk.dirs.clear();
  vi.resetModules();
});

async function wire() {
  const learn = await import("./skillLearn");
  const changes = await import("../../hub/model/botChanges");
  const skills = await import("../../skills/model/skills");
  return { ...learn, ...changes, blankSkillMarkdown: skills.blankSkillMarkdown };
}

const SKILL = "/Users/ash/.agents/skills/reviewing-a-diff/SKILL.md";

it("a lesson is one plain sentence, whatever the model sent", async () => {
  const { plainLesson } = await wire();
  expect(plainLesson("  - Read the caller first.\n")).toBe("Read the caller first.");
  expect(plainLesson("1. Two\n   lines")).toBe("Two lines");
  const long = plainLesson("x".repeat(500));
  expect(long.length).toBeLessThanOrEqual(400);
  expect(long.endsWith("…")).toBe(true);
});

it("a skill with no lessons gets the section; one that has it gets the bullet under it", async () => {
  const { addLesson } = await wire();
  expect(addLesson("# Title\n\n## Instructions\n\nDo it.\n", "Read the caller first.")).toBe(
    "# Title\n\n## Instructions\n\nDo it.\n\n## Lessons\n\n- Read the caller first.\n",
  );
  expect(addLesson("# T\n\n## Lessons\n\n- one\n\n## Notes\n\nlast\n", "two")).toBe(
    "# T\n\n## Lessons\n\n- one\n- two\n\n## Notes\n\nlast\n",
  );
});

it("taking a lesson out keeps the others, and the last one out takes the empty heading with it", async () => {
  const { removeLesson } = await wire();
  expect(removeLesson("# T\n\n## Lessons\n\n- one\n- two\n", "one")).toBe("# T\n\n## Lessons\n\n- two\n");
  expect(removeLesson("# T\n\n## Instructions\n\nx\n\n## Lessons\n\n- only\n", "only")).toBe(
    "# T\n\n## Instructions\n\nx\n",
  );
  expect(removeLesson("# T\n\n## Lessons\n\n- one\n", "not there")).toBeUndefined();
  expect(removeLesson("# T\n\n## Instructions\n\nx\n", "one")).toBeUndefined();
});

it("a lesson makes the skill when it is missing, is logged with Undo, and Undo takes it back out", async () => {
  const { learnSkillLesson, flowChanges, findBotChange, undoBotChange, redoBotChange, SKILL_LEARN, blankSkillMarkdown } =
    await wire();

  const learned = await learnSkillLesson({
    skill: "Reviewing a diff",
    lesson: "- Read the caller before changing the callee.",
    from: "worker 2",
    by: "Chief of Staff",
  });
  expect(learned.skill).toBe("reviewing-a-diff");
  expect(learned.path).toBe(SKILL);
  expect(disk.dirs.has("/Users/ash/.agents/skills/reviewing-a-diff")).toBe(true);
  expect(disk.files.get(SKILL)).toContain("## Lessons\n\n- Read the caller before changing the callee.\n");

  const rows = flowChanges(SKILL_LEARN);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    bot: "Chief of Staff",
    after: "Read the caller before changing the callee.",
    now: "Not in Reviewing A Diff",
    line: "Chief of Staff wrote a lesson from worker 2's review into Reviewing A Diff",
    flow: { kind: SKILL_LEARN, data: { skill: "reviewing-a-diff", lesson: "Read the caller before changing the callee." } },
  });

  await undoBotChange([rows[0].id]);
  expect(findBotChange(rows[0].id)?.undone).toBe(true);
  expect(findBotChange(rows[0].id)?.problem).toBeUndefined();
  expect(disk.files.get(SKILL)).toBe(blankSkillMarkdown("reviewing-a-diff").trimEnd() + "\n");
  expect(disk.files.get(SKILL)).not.toContain("## Lessons");

  await redoBotChange([rows[0].id]);
  expect(disk.files.get(SKILL)).toContain("- Read the caller before changing the callee.");
});

it("the same lesson twice changes nothing, and a made-up skill name is refused", async () => {
  const { learnSkillLesson, flowChanges, SKILL_LEARN } = await wire();
  const input = { skill: "reviewing-a-diff", lesson: "Read the caller first.", by: "Chief of Staff" };
  await learnSkillLesson(input);
  const again = await learnSkillLesson(input);
  expect(again.note).toContain("already has that lesson");
  expect(flowChanges(SKILL_LEARN)).toHaveLength(1);
  await expect(learnSkillLesson({ ...input, skill: "!!!" })).rejects.toThrow("lowercase letters");
});
