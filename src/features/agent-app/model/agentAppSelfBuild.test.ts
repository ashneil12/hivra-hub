// The app side of the lesson tool (ash-day step 16): only a seated Mono may file one, and it lands as that Mono's row.
import { beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";

const learn = vi.hoisted(() => vi.fn());

vi.mock("../../selfBuild/model/skillLearn", () => ({ learnSkillLesson: learn }));

beforeEach(() => {
  learn.mockReset();
  learn.mockResolvedValue({ skill: "reviewing-a-diff", lesson: "Read the caller.", path: "/x", note: "in" });
});

async function call(action: string, input: Record<string, unknown>, host: Record<string, unknown>) {
  const { handleSelfBuild } = await import("./agentAppSelfBuild");
  const delegate = vi.fn();
  return handleSelfBuild({ id: "s1", harness: "claude", cwd: "/w" } as unknown as Session, action, input, host as never, delegate);
}

it("a temporary worker can't file a lesson, and neither can a worker chat's own turn", async () => {
  await expect(call("skills.learn", { skill: "a", lesson: "b" }, { isMono: () => false })).rejects.toThrow(
    "Only one of your own Monos",
  );
});

it("a seated Mono files it as itself, naming the worker whose review it came from", async () => {
  const host = {
    isMono: () => true,
    monoOf: () => ({ id: "m1", name: "Chief of Staff", projects: ["p"] }),
  };
  await expect(call("skills.learn", { skill: "reviewing-a-diff", lesson: "Read the caller first.", from: "worker 2" }, host)).resolves.toMatchObject({
    skill: "reviewing-a-diff",
  });
  expect(learn).toHaveBeenCalledWith({
    skill: "reviewing-a-diff",
    lesson: "Read the caller first.",
    from: "worker 2",
    by: "Chief of Staff",
  });
});

it("a lesson with no skill or no sentence is refused before anything is written", async () => {
  const host = { isMono: () => true, monoOf: () => ({ id: "m1", name: "Chief of Staff", projects: [] }) };
  await expect(call("skills.learn", { lesson: "Read the caller." }, host)).rejects.toThrow("skill must be");
  await expect(call("skills.learn", { skill: "reviewing-a-diff", lesson: "  " }, host)).rejects.toThrow("lesson must be");
  expect(learn).not.toHaveBeenCalled();
});
