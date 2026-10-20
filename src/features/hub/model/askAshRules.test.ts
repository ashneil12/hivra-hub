// What every Mono is told about asking Ash, and that the shapes it is told to use are exactly what Today reads.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { monoContext } from "../../monos/model/monoFiles";
import { ASK_ASH_RULES } from "./askAshRules";
import { chatQuestion } from "./chatQuestions";

const look = { name: "EXO lead", mascot: "robot", color: "#888", projects: [{ path: "/code/vg-game", name: "vg-game" }] };
const files = { soul: "Lead the project.", memory: "", topics: [] } as unknown as Parameters<typeof monoContext>[1];

describe("asking Ash, as every Mono is told", () => {
  it("is in the Mono's context with its soul (live chats get it once: the prompt version moved)", () => {
    const full = monoContext(look, files, { soul: true, memory: false });
    expect(full).toContain(ASK_ASH_RULES);
    expect(full).toContain("Come back to him only with something that truly needs him");
    expect(full).toContain("Don't queue questions with ash_ask_ash");
    expect(full).toContain("Workers you delegate to ask you, not Ash");
    expect(monoContext(look, files, { soul: false, memory: true })).not.toContain("<ask_ash_rules>");
  });

  it("a turn that ends the way the rules say is a waiting chat with the agent's pick", () => {
    const reply = "The parser is in.\n\nNeeds Ash: Replace the old parser now, or keep both for a week?\nMy pick: Keep both for a week.";
    expect(chatQuestion({ busy: false, blocks: [{ role: "user", text: "go" }, { role: "assistant", text: reply }] })).toEqual({
      source: "marker",
      question: "Replace the old parser now, or keep both for a week?",
      more: 0,
      pick: "Keep both for a week.",
      redLine: false,
    });
    const red = "Needs Ash (red line): Email the waitlist about the delay?\nMy pick: Wait until Friday.";
    expect(chatQuestion({ busy: false, blocks: [{ role: "assistant", text: red }] })?.redLine).toBe(true);
  });

  it("an AskUserQuestion with the recommended option marked the way the rules say has that option as its pick", () => {
    const q = chatQuestion({
      pendingQuestion: {
        requestId: 1,
        questions: [{ id: "q", prompt: "Which area first?", multiSelect: false, allowCustom: true, options: [{ id: "a", label: "Yard (Recommended)" }, { id: "b", label: "Furnace" }] }],
      },
      blocks: [],
    });
    expect(q?.pick).toBe("Yard");
  });
});
