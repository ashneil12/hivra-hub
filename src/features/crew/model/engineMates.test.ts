import { describe, expect, it } from "vitest";
import { engineBriefingId, engineMateBriefing, engineMatesNote } from "./engineMates";

describe("what a chat on the engine is told about handing work down", () => {
  it("lists each first mate's conversation and names the engine's tools, never the app's delegate tool as one to use", () => {
    const note = engineMatesNote([
      { name: "EXO lead", project: "EXO", threadId: "thread-exo" },
      { name: "Hivra lead", project: "Hivra", threadId: "thread-hivra" },
    ]);
    expect(note).toContain('- EXO lead (project EXO): threadId "thread-exo"');
    expect(note).toContain('- Hivra lead (project Hivra): threadId "thread-hivra"');
    expect(note).toContain("t3_thread_send");
    expect(note).toContain("t3_thread_wait");
    expect(note).toContain("delegate_task, mono_message and the `app` command do not exist here");
    expect(note?.startsWith("<first_mates>")).toBe(true);
    expect(note?.endsWith("</first_mates>")).toBe(true);
  });

  it("says nothing when there is no first mate to reach", () => {
    expect(engineMatesNote([])).toBeUndefined();
  });

  it("briefs a first mate once per chat: who hands it work, how to answer, and nothing to do yet", () => {
    const briefing = engineMateBriefing("Chief of Staff");
    expect(briefing.startsWith("[MonoCode briefing]")).toBe(true);
    expect(briefing).toContain("Chief of Staff hands you work in this conversation");
    expect(briefing).toContain("Reply with exactly: Ready.");
    expect(engineBriefingId("thread-1")).toBe("engine-briefing-thread-1");
  });
});
