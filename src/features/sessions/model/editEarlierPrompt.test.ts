import { describe, expect, it } from "vitest";
import {
  applyEarlierEdit,
  earlierEditDecision,
  earlierEditNeedsConfirm,
  EARLIER_PROMPT_NOTE,
} from "./editEarlierPrompt";
import type { Block } from "./session";

const user = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  role: "user",
  text,
  ...extra,
});
const reply = (id: string, text: string): Block => ({ id, role: "assistant", text });

describe("applyEarlierEdit", () => {
  const blocks = [
    user("a", "first"),
    reply("b", "answer"),
    user("c", "second"),
    reply("d", "later"),
  ];

  it("drops the prompt and everything after it, and leaves a note", () => {
    const next = applyEarlierEdit(blocks, "a");
    expect(next?.map((block) => block.id)).toEqual(["earlier-prompt-a"]);
    expect(next?.[0]).toMatchObject({ role: "system", text: EARLIER_PROMPT_NOTE });
  });

  it("keeps turns that came before the edited prompt", () => {
    const next = applyEarlierEdit(blocks, "c");
    expect(next?.map((block) => block.role)).toEqual(["user", "assistant", "system"]);
    expect(next?.[0].id).toBe("a");
    expect(next?.[2].text).toBe(EARLIER_PROMPT_NOTE);
  });

  it("adds no note when nothing after the prompt would be removed", () => {
    expect(applyEarlierEdit([user("a", "only")], "a")).toEqual([]);
    expect(earlierEditNeedsConfirm([user("a", "only")], "a")).toBe(false);
  });

  it("asks before discarding later work, and not when there is none", () => {
    expect(earlierEditNeedsConfirm(blocks, "a")).toBe(true);
    expect(earlierEditNeedsConfirm(blocks, "missing")).toBe(false);
  });

  it.each([
    ["missing", [user("a", "hi")], "gone"],
    ["draft", [user("a", "hi", { draft: true })], "a"],
    ["internal", [user("a", "hi", { internal: true })], "a"],
    ["blank", [user("a", "  \n")], "a"],
    ["app note", [user("a", "[MonoCode check] From the app: look again")], "a"],
  ])("refuses a %s prompt", (_label, source, id) => {
    expect(applyEarlierEdit(source, id)).toBeNull();
    expect(earlierEditNeedsConfirm(source, id)).toBe(false);
  });

  it("does not reuse a note id that is already in the kept transcript", () => {
    const source = [user("earlier-prompt-a", "kept"), user("a", "edit"), reply("b", "later")];
    expect(applyEarlierEdit(source, "a")?.map((block) => block.id)).toEqual([
      "earlier-prompt-a",
      "earlier-prompt-a-again",
    ]);
  });

  it("treats a busy chat, or a prompt that vanished, as a refusal", () => {
    expect(earlierEditDecision(true, blocks, "a")).toBe("reject");
    expect(earlierEditDecision(false, blocks, "gone")).toBe("reject");
    expect(earlierEditDecision(false, blocks, "c")).toBe("ready");
  });
});
