// @vitest-environment happy-dom
// The unattended-run rules a habit carries, and the one send-back a finished run can get (OpenBot by CopilotKit, MIT).
import { describe, expect, it } from "vitest";
import type { MonoLook } from "./mono";
import type { MonoFiles } from "./monoFiles";
import { habitFollowUp, habitRunPrompt, QUIET_MARKER, type Habit } from "./monoHabits";

const LOOK: MonoLook = { name: "Chief", mascot: "orb", color: "hsl(0 0% 50%)", projects: [] };
const FILES: MonoFiles = { id: "chief", dir: "/tmp/chief", soul: "", soulHash: "", memory: "", memoryHash: "", memoryPath: "/tmp/chief/memory.md", topics: [] };
const LIST = "1. Pull the open PRs on hivra-hub\n2. Check which ones have red CI\n3. Post a one-line summary";

function habit(instructions: string): Habit {
  return { id: "h1", name: "PR sweep", instructions, schedule: { kind: "daily", at: "09:00" }, enabled: true, createdAt: 1 } as unknown as Habit;
}

describe("habit run prompt", () => {
  it("says nobody is watching and asks for the gaps in their own part", () => {
    const prompt = habitRunPrompt(LOOK, FILES, habit("Check the PR queue."), 1);
    expect(prompt).toContain("Nobody is watching this run");
    expect(prompt).toContain("that is not a question for you to ask");
    expect(prompt).toContain('"What I could not confirm"');
    expect(prompt).not.toContain("This habit has");
  });

  it("numbers a list habit's parts to close", () => {
    const prompt = habitRunPrompt(LOOK, FILES, habit(LIST), 1);
    expect(prompt).toContain("This habit has 3 parts. Before you finish, close every one by its number");
    expect(prompt).toContain("2. Check which ones have red CI");
    expect(prompt.indexOf("Habit: PR sweep")).toBeLessThan(prompt.indexOf("This habit has 3 parts"));
  });
});

describe("habitFollowUp", () => {
  it("sends a list habit back with the parts still open", () => {
    const back = habitFollowUp(LIST, "Pulled 4 PRs.\n1. Done\n2. Blocked: CI API timed out");
    expect(back).toContain("still open: 3. Post a one-line summary");
  });

  it("leaves a list habit whose parts are all closed", () => {
    expect(habitFollowUp(LIST, "1. Done\n2. Done\n3. Skipped: nothing to post")).toBeUndefined();
  });

  it("sends back an answer that ends on a promise", () => {
    expect(habitFollowUp("Check the PR queue.", "Found 4 PRs. I'll check their CI now.")).toContain(`"I'll check their CI now."`);
  });

  it("never sends back a quiet run or an empty one", () => {
    expect(habitFollowUp(LIST, QUIET_MARKER)).toBeUndefined();
    expect(habitFollowUp(LIST, "  ")).toBeUndefined();
    expect(habitFollowUp("Check the PR queue.", "All four PRs are green.")).toBeUndefined();
  });
});
