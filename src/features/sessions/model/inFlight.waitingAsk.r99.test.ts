// r99 (Ash, 30 Oct): "a chat that's only waiting on Ash's answer isn't running". Run deb4 (r98) sat 45 min unable to
// quit because the Chief of Staff's turn was held open by its own AskUserQuestion. Quit must not count it, the ask
// must be kept with the in-flight row, and the reopened app must ask it again.
import { describe, expect, it } from "vitest";
import { newTab } from "../../workspace/model/layout";
import { askCut, inFlightRefs, isInFlightSession, isRunningWork, resumePrompt, withInFlightState } from "./inFlight";
import { newSession, type Session } from "./session";

const question = {
  requestId: 7,
  questions: [
    {
      id: "q1",
      prompt: "Publish the privacy page now?",
      multiSelect: false,
      allowCustom: true,
      options: [
        { label: "Wait for my wording" },
        { label: "Publish" },
      ],
    },
  ],
} as unknown as NonNullable<Session["pendingQuestion"]>;

function chat(patch: Partial<Session> = {}): Session {
  const session = newSession("claude", "/tmp/cos");
  session.blocks = [{ id: "u1", role: "user", text: "park the rest" }];
  return { ...session, ...patch, blocks: patch.blocks ?? session.blocks };
}

describe("r99: a chat waiting only on Ash's answer isn't running", () => {
  it("doesn't count an open ask as running work, but still resumes it", () => {
    const asking = chat({ busy: true, pendingQuestion: question });
    expect(isRunningWork(asking)).toBe(false);
    expect(isInFlightSession(asking)).toBe(true);
    expect(isRunningWork(chat({ busy: true }))).toBe(true);
    expect(isRunningWork(chat())).toBe(false);
  });

  it("keeps the ask with the in-flight row and asks it again after the reopen", () => {
    const asking = chat({ busy: true, pendingQuestion: question });
    const [ref] = inFlightRefs([asking], [newTab(asking.id)]);
    expect(ref.background).toEqual([askCut(asking)]);
    expect(ref.background?.[0]).toMatchObject({ kind: "ask", label: "Publish the privacy page now? [Wait for my wording / Publish]" });

    const restored = withInFlightState(chat({ id: asking.id } as Partial<Session>), ref);
    const prompt = resumePrompt(restored);
    expect(prompt).toContain("ask it again (AskUserQuestion)");
    expect(prompt).toContain("Publish the privacy page now? [Wait for my wording / Publish]");
    // The ask isn't reported as cut background work.
    expect(prompt).not.toContain("this background work was cut");
  });
});
